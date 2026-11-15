import type { ClienteFiscal, Env, Item, Orden } from "../types";
import { evaluarYTimbrar } from "./facturapi";
import {
  clearFiscalDraft,
  draftComplete,
  isFiscalWizardState,
  loadFiscalDraft,
  normalizeRfc,
  REGIMEN_OPTIONS,
  saveFiscalDraft,
  USO_OPTIONS,
  validateCp,
  validateNombre,
  validateRfc,
} from "./fiscal-wizard";
import { checkRfcEfos, validateFiscalWithSat } from "./sat-validate";
import {
  conceptForPey,
  nowIso,
  parseFiscalData,
  parseProductLines,
  sumItems,
} from "./parse";
import {
  crearQrPey,
  extractQrPayload,
  getQrExpiresInSec,
  QR_TTL_SEC,
  storeQrPng,
} from "./pey";
import { formatTicketCaption } from "./ticket";
import {
  resolveInteractiveId,
  sendWhatsapp,
  sendWhatsappList,
  sendWhatsappQuickReply,
} from "./twilio";

function parseOrdenItems(orden: Orden): Item[] {
  try {
    const raw = JSON.parse(orden.conceptos) as Item[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

const DEMO_FISCAL = {
  rfc: "XAXX010101000",
  razon_social: "PUBLICO EN GENERAL",
  codigo_postal: "06600",
  regimen: "616",
  uso_cfdi: "G03",
};

const CATALOG: Array<{ id: string; item: string; description: string; line: string }> = [
  {
    id: "PROD_PRUEBA_001",
    item: "Prueba CoDi $0.01",
    description: "Demo de liquidación Banxico",
    line: "1 Prueba CoDi 0.01",
  },
  {
    id: "PROD_CAFE_045",
    item: "Café $45.00",
    description: "1 × Café americano",
    line: "1 Cafe 45",
  },
  {
    id: "PROD_AGUA_010",
    item: "Agua $10.00",
    description: "1 × Agua embotellada",
    line: "1 Agua 10",
  },
  {
    id: "PROD_CUSTOM",
    item: "Escribir mi pedido",
    description: "cantidad concepto precio",
    line: "",
  },
];

const MENU_ACTIONS: Array<{ id: string; item: string; description: string }> = [
  { id: "STATUS", item: "Estado del cobro", description: "Orden activa y vigencia QR" },
  { id: "HISTORY", item: "Historial", description: "Últimas 5 órdenes" },
  { id: "QR_RENEW", item: "Nuevo QR", description: "Si venció la solicitud CoDi" },
  { id: "CANCEL", item: "Cancelar cobro", description: "Si ya no se va a cobrar" },
];

async function getActiveOrder(
  env: Env,
  telefono: string,
): Promise<Orden | null> {
  return env.DB.prepare(
    `SELECT * FROM ordenes
     WHERE telefono = ?
       AND estado_chat NOT IN ('COMPLETADO', 'CANCELADO')
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(telefono)
    .first<Orden>();
}

async function upsertClienteFiscal(
  env: Env,
  telefono: string,
  data: Record<string, string>,
): Promise<number> {
  const existing = await env.DB.prepare(
    "SELECT id FROM clientes_fiscales WHERE telefono = ?",
  )
    .bind(telefono)
    .first<{ id: number }>();
  const ts = nowIso();
  if (existing) {
    await env.DB.prepare(
      `UPDATE clientes_fiscales
       SET rfc = ?, razon_social = ?, codigo_postal = ?, regimen = ?, uso_cfdi = ?, updated_at = ?
       WHERE telefono = ?`,
    )
      .bind(
        data.rfc,
        data.razon_social,
        data.codigo_postal,
        data.regimen,
        data.uso_cfdi,
        ts,
        telefono,
      )
      .run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    `INSERT INTO clientes_fiscales
      (telefono, rfc, razon_social, codigo_postal, regimen, uso_cfdi, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      telefono,
      data.rfc,
      data.razon_social,
      data.codigo_postal,
      data.regimen,
      data.uso_cfdi,
      ts,
    )
    .run();
  return Number(res.meta.last_row_id);
}

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function askMenu(env: Env, telefono: string): Promise<string> {
  const body =
    "🛒 *Cobro CoDi + CFDI 4.0*\nElige un producto, revisa tu cobro o escribe:\n`cantidad concepto precio`";
  const items = [
    ...CATALOG.map((c) => ({
      id: c.id,
      item: c.item,
      description: c.description,
    })),
    ...MENU_ACTIONS,
  ];
  const sent = await sendWhatsappList(
    env,
    telefono,
    body,
    "Ver opciones",
    items,
  );
  if (sent) return "";
  return (
    `${body}\n\n` +
    [...CATALOG.map((c, i) => `${i + 1}) ${c.item}`), "estado · historial · nuevo qr"]
      .join("\n")
  );
}

async function askFacturaChoice(
  env: Env,
  telefono: string,
  ordenId: number,
  total: string,
  resumen: string,
): Promise<string> {
  const body =
    `✅ *Orden #${ordenId}*\n${resumen}\n\n*Total: $${total} MXN*\n\n¿El cliente necesita factura?`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Sí, factura", id: "FACTURA_SI" },
    { title: "Solo pagar", id: "FACTURA_NO" },
  ]);
  if (sent) return "";
  return `${body}\n\nResponde *1* = Sí  |  *2* = No`;
}

async function setOrdenEstado(
  env: Env,
  ordenId: number,
  estado: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ordenes SET estado_chat = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(estado, nowIso(), ordenId)
    .run();
}

/** Entrada fiscal para tienda de barrio: un toque o te guiamos paso a paso. */
async function askFiscalActions(
  env: Env,
  telefono: string,
  orden: Orden,
): Promise<string> {
  const body =
    `🧾 *Factura* — orden #${orden.id} ($${orden.monto} MXN)\n\n` +
    `Primero cerramos la factura; *el QR de pago llega al final* para que no se pierda.\n\n` +
    `En la mayoría de las tiendas basta con *Sin RFC*.\n` +
    `Si el cliente trae RFC, lo llenamos juntitos, una pregunta a la vez.`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Sin RFC", id: "FISCAL_DEMO" },
    { title: "Sí tengo RFC", id: "FISCAL_EDIT" },
    { title: "Menú", id: "MENU" },
  ]);
  if (sent) return "";
  return `${body}\n\nResponde *sin rfc* o *tengo rfc*.`;
}

async function askSavedFiscalChoice(
  env: Env,
  telefono: string,
  saved: ClienteFiscal,
): Promise<string> {
  const corto =
    saved.razon_social.length > 28
      ? `${saved.razon_social.slice(0, 28)}…`
      : saved.razon_social;
  const body =
    `¿Facturamos con los datos que ya tenemos?\n` +
    `*${saved.rfc}* · ${corto}\n\n` +
    `El QR CoDi se envía en cuanto confirmes.`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Sí, esos", id: "FISCAL_KEEP" },
    { title: "Sin RFC", id: "FISCAL_DEMO" },
    { title: "Otros datos", id: "FISCAL_EDIT" },
  ]);
  if (sent) return "";
  return `${body}\n\nResponde *si*, *sin rfc* u *otros*.`;
}

async function startFiscalWizard(
  env: Env,
  telefono: string,
  orden: Orden,
): Promise<string> {
  await clearFiscalDraft(env, telefono);
  await saveFiscalDraft(env, telefono, {});
  await env.DB.prepare(
    `UPDATE ordenes SET estado_chat = 'ESPERANDO_FISCAL_RFC', datos_fiscales_ok = 0, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), orden.id)
    .run();
  const body =
    `Perfecto. Vamos despacio 👍\n\n` +
    `*Paso 1 de 5 — RFC*\n` +
    `Escríbelo tal cual viene en la constancia (12 o 13 caracteres).\n` +
    `Lo revisamos contra el SAT (no hace falta entrar al portal).\n` +
    `Ejemplo: \`VECJ880326XXX\``;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Mejor Sin RFC", id: "FISCAL_DEMO" },
    { title: "Cancelar", id: "MENU" },
  ]);
  return sent ? "" : body;
}

async function askFiscalNombre(env: Env, telefono: string): Promise<string> {
  const body =
    `*Paso 2 de 5 — Nombre*\n` +
    `¿Cómo se llama la persona o el negocio?\n` +
    `(Como en la constancia del SAT)`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Mejor Sin RFC", id: "FISCAL_DEMO" },
  ]);
  return sent ? "" : body;
}

async function askFiscalCp(env: Env, telefono: string): Promise<string> {
  const body =
    `*Paso 3 de 5 — Código postal*\n` +
    `Los *5 dígitos* del domicilio fiscal.\n` +
    `Ejemplo: \`06600\``;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Mejor Sin RFC", id: "FISCAL_DEMO" },
  ]);
  return sent ? "" : body;
}

async function askFiscalRegimen(env: Env, telefono: string): Promise<string> {
  const body =
    `*Paso 4 de 5 — Régimen*\n` +
    `Elige el que más se parezca (si dudas, *RESICO* suele ser el de personas físicas).`;
  const sent = await sendWhatsappList(
    env,
    telefono,
    body,
    "Elegir régimen",
    REGIMEN_OPTIONS.map((o) => ({
      id: o.id,
      item: o.item,
      description: o.description,
    })),
  );
  if (sent) return "";
  return (
    `${body}\n\n` +
    REGIMEN_OPTIONS.map((o, i) => `${i + 1}) ${o.item}`).join("\n")
  );
}

async function askFiscalUso(env: Env, telefono: string): Promise<string> {
  const body =
    `*Paso 5 de 5 — ¿Para qué la factura?*\n` +
    `Si no estás seguro, elige *Gastos en general*.`;
  const sent = await sendWhatsappList(
    env,
    telefono,
    body,
    "Elegir uso",
    USO_OPTIONS.map((o) => ({
      id: o.id,
      item: o.item,
      description: o.description,
    })),
  );
  if (sent) return "";
  return (
    `${body}\n\n` + USO_OPTIONS.map((o, i) => `${i + 1}) ${o.item}`).join("\n")
  );
}

async function advanceFiscalWizard(
  env: Env,
  publicUrl: string,
  telefono: string,
  orden: Orden,
  estado: string,
  interactive: string,
  text: string,
): Promise<string> {
  // Escape hatches always available
  if (interactive === "FISCAL_DEMO") {
    await clearFiscalDraft(env, telefono);
    return applyFiscalAndContinue(env, publicUrl, telefono, orden, DEMO_FISCAL);
  }
  if (interactive === "FISCAL_EDIT") {
    return startFiscalWizard(env, telefono, orden);
  }
  if (interactive === "MENU" || interactive === "HELP") {
    await clearFiscalDraft(env, telefono);
    return askMenu(env, telefono);
  }
  if (interactive === "QR_RESEND" || interactive === "QR_RENEW") {
    if (!orden.pey_qr_id && interactive === "QR_RESEND") {
      return "Aún no hay QR. Termina la factura y te lo mando al cerrar.";
    }
    return resendOrRenewQr(
      env,
      publicUrl,
      telefono,
      orden,
      interactive === "QR_RENEW",
    );
  }

  const draft = await loadFiscalDraft(env, telefono);

  if (estado === "ESPERANDO_FISCAL_RFC") {
    const err = validateRfc(text);
    if (err) {
      const retry =
        `${err}\n\n*Paso 1 de 5 — RFC*\nEscríbelo sin espacios. Ejemplo: \`VECJ880326XXX\``;
      const sent = await sendWhatsappQuickReply(env, telefono, retry, [
        { title: "Mejor Sin RFC", id: "FISCAL_DEMO" },
        { title: "Cancelar", id: "MENU" },
      ]);
      return sent ? "" : retry;
    }
    const rfc = normalizeRfc(text);
    const efos = await checkRfcEfos(env, rfc);
    if (!efos.ok) {
      const sent = await sendWhatsappQuickReply(env, telefono, efos.hint, [
        { title: "Otro RFC", id: "FISCAL_EDIT" },
        { title: "Sin RFC", id: "FISCAL_DEMO" },
        { title: "Menú", id: "MENU" },
      ]);
      return sent ? "" : efos.hint;
    }

    draft.rfc = rfc;
    await saveFiscalDraft(env, telefono, draft);
    await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_NOMBRE");
    if (efos.hint) {
      await sendWhatsapp(env, telefono, efos.hint);
    }
    return askFiscalNombre(env, telefono);
  }

  if (estado === "ESPERANDO_FISCAL_NOMBRE") {
    const err = validateNombre(text);
    if (err) return err;
    draft.razon_social = text.trim();
    await saveFiscalDraft(env, telefono, draft);
    await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_CP");
    return askFiscalCp(env, telefono);
  }

  if (estado === "ESPERANDO_FISCAL_CP") {
    const err = validateCp(text);
    if (err) return err;
    draft.codigo_postal = text.trim();
    await saveFiscalDraft(env, telefono, draft);
    await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_REGIMEN");
    return askFiscalRegimen(env, telefono);
  }

  if (estado === "ESPERANDO_FISCAL_REGIMEN") {
    let picked = REGIMEN_OPTIONS.find((o) => o.id === interactive);
    if (!picked && /^\d+$/.test(text)) {
      picked = REGIMEN_OPTIONS[Number(text) - 1];
    }
    if (!picked) {
      picked = REGIMEN_OPTIONS.find((o) => o.code === text.trim());
    }
    if (!picked) {
      return askFiscalRegimen(env, telefono);
    }
    draft.regimen = picked.code;
    await saveFiscalDraft(env, telefono, draft);
    await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_USO");
    return askFiscalUso(env, telefono);
  }

  if (estado === "ESPERANDO_FISCAL_USO") {
    let picked = USO_OPTIONS.find((o) => o.id === interactive);
    if (!picked && /^\d+$/.test(text)) {
      picked = USO_OPTIONS[Number(text) - 1];
    }
    if (!picked) {
      picked = USO_OPTIONS.find(
        (o) => o.code === text.trim().toUpperCase(),
      );
    }
    if (!picked) {
      return askFiscalUso(env, telefono);
    }
    draft.uso_cfdi = picked.code;
    await saveFiscalDraft(env, telefono, draft);
    if (!draftComplete(draft)) {
      await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_RFC");
      return startFiscalWizard(env, telefono, orden);
    }

    await sendWhatsapp(
      env,
      telefono,
      "Un segundo… estoy confirmando estos datos con el SAT ⏳",
    );
    const sat = await validateFiscalWithSat(env, {
      rfc: draft.rfc,
      razon_social: draft.razon_social,
      codigo_postal: draft.codigo_postal,
      regimen: draft.regimen,
    });
    if (!sat.ok) {
      const msg =
        `No cuadran con el SAT:\n` +
        sat.hints.map((h) => `• ${h}`).join("\n") +
        `\n\nCorrige con los botones o empieza de nuevo.`;
      const sent = await sendWhatsappQuickReply(env, telefono, msg, [
        { title: "Empezar de nuevo", id: "FISCAL_EDIT" },
        { title: "Sin RFC", id: "FISCAL_DEMO" },
        { title: "Menú", id: "MENU" },
      ]);
      // Volver a CP o nombre según el error más común
      if (sat.hints.some((h) => /postal|código postal/i.test(h))) {
        await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_CP");
      } else if (sat.hints.some((h) => /nombre|razón|legal_name/i.test(h))) {
        await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_NOMBRE");
      } else if (sat.hints.some((h) => /régimen|regimen/i.test(h))) {
        await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_REGIMEN");
      }
      return sent ? "" : msg;
    }

    await clearFiscalDraft(env, telefono);
    const okHint = sat.hints[0] ? `${sat.hints[0]}\n` : "";
    const saved = await applyFiscalAndContinue(env, publicUrl, telefono, orden, {
      rfc: draft.rfc,
      razon_social: draft.razon_social,
      codigo_postal: draft.codigo_postal,
      regimen: draft.regimen,
      uso_cfdi: draft.uso_cfdi,
    });
    return `${okHint}${saved}`;
  }

  return askFiscalActions(env, telefono, orden);
}

async function replyStatus(
  env: Env,
  publicUrl: string,
  telefono: string,
  orden: Orden | null,
): Promise<string> {
  if (!orden) {
    const msg =
      "No tienes un cobro activo.\nAbre el menú para iniciar uno nuevo.";
    const sent = await sendWhatsappQuickReply(env, telefono, msg, [
      { title: "Menú", id: "MENU" },
    ]);
    return sent ? "" : msg;
  }

  const expires = await getQrExpiresInSec(env, orden);
  const vencido =
    orden.pago_estado === "PENDIENTE" && !!orden.pey_qr_id && expires === 0;
  const vigencia = !orden.pey_qr_id
    ? "sin QR aún"
    : vencido
      ? "VENCIDA (0:00)"
      : formatMmSs(expires);

  let body =
    `📋 *Orden #${orden.id}*\n` +
    `Monto: $${orden.monto} MXN\n` +
    `Pago: ${orden.pago_estado}\n` +
    `Chat: ${orden.estado_chat}\n` +
    `Vigencia QR: ${vigencia}`;

  if (vencido) {
    body +=
      `\n\n⚠️ La solicitud CoDi *venció* (~${Math.floor(QR_TTL_SEC / 60)} min). ` +
      `Banxico ya no la acepta. Genera un *Nuevo QR* (mismo monto) o inicia otro pedido.`;
  } else if (orden.pey_qr_id) {
    body += `\nTicket: ${publicUrl}/files/qr_${orden.id}.png`;
  }

  const actions = vencido
    ? [
        { title: "Nuevo QR", id: "QR_RENEW" },
        { title: "Menú", id: "MENU" },
        { title: "Historial", id: "HISTORY" },
      ]
    : [
        { title: "Reenviar QR", id: "QR_RESEND" },
        { title: "Menú", id: "MENU" },
        { title: "Historial", id: "HISTORY" },
      ];

  const sent = await sendWhatsappQuickReply(env, telefono, body, actions);
  return sent ? "" : body;
}

async function replyHistory(env: Env, telefono: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT id, monto, pago_estado, estado_chat, facturapi_id, created_at
     FROM ordenes WHERE telefono = ?
     ORDER BY id DESC LIMIT 5`,
  )
    .bind(telefono)
    .all<{
      id: number;
      monto: string;
      pago_estado: string;
      estado_chat: string;
      facturapi_id: string | null;
      created_at: string;
    }>();

  if (!results?.length) {
    const empty = "Aún no hay órdenes en este número.";
    const sent = await sendWhatsappQuickReply(env, telefono, empty, [
      { title: "Menú", id: "MENU" },
    ]);
    return sent ? "" : empty;
  }

  const lines = results.map((o) => {
    const stamp = o.facturapi_id ? " · CFDI" : "";
    return `• #${o.id} $${o.monto} — ${o.pago_estado} / ${o.estado_chat}${stamp}`;
  });
  const body =
    `🗂️ *Últimas órdenes*\n${lines.join("\n")}\n\n` +
    `Para un cobro nuevo abre el menú. Para revisar detalle usa la consola /admin.`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Estado", id: "STATUS" },
    { title: "Menú", id: "MENU" },
  ]);
  return sent ? "" : body;
}

async function emitirQr(
  env: Env,
  publicUrl: string,
  telefono: string,
  orden: Orden,
  opts?: { announceOnly?: boolean },
): Promise<string> {
  const concepto =
    orden.concepto_pey ||
    conceptForPey(JSON.parse(orden.conceptos) as Item[], orden.id);
  let peyData: Record<string, unknown>;
  try {
    peyData = await crearQrPey(env, orden.id, Number(orden.monto), concepto);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = `⚠️ No pudimos generar el QR CoDi.\n${raw}`;
    await sendWhatsapp(env, telefono, msg);
    return msg;
  }
  const qrPayload = extractQrPayload(peyData);
  const peyQrId =
    String(peyData.id || peyData.qrId || peyData.uuid || "") || null;
  const items = parseOrdenItems(orden);
  await storeQrPng(env, orden.id, qrPayload, {
    items,
    monto: String(orden.monto),
    concepto,
    peyQrId,
  });
  await env.DB.prepare(
    `UPDATE ordenes SET pey_qr_id = ?, concepto_pey = ?, estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
  )
    .bind(peyQrId, concepto, nowIso(), orden.id)
    .run();

  const media = `${publicUrl}/files/qr_${orden.id}.png`;
  const ticketUrl = `${publicUrl}/ticket/${orden.id}`;
  const qrMsg = formatTicketCaption(
    {
      ordenId: orden.id,
      monto: String(orden.monto),
      items,
      concepto,
      vigenciaMin: Math.floor(QR_TTL_SEC / 60),
      peyQrId,
    },
    { mediaUrl: media, ticketUrl },
  );

  const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (hasTwilio) {
    await sendWhatsapp(env, telefono, qrMsg, media);
    if (!opts?.announceOnly) {
      await sendWhatsappQuickReply(
        env,
        telefono,
        `Ticket listo. Para escanear más fácil ábrelo a pantalla completa:\n${ticketUrl}\nSi vence (~10 min), pide *Nuevo QR*.`,
        [
          { title: "Estado", id: "STATUS" },
          { title: "Nuevo QR", id: "QR_RENEW" },
          { title: "Menú", id: "MENU" },
        ],
      );
    }
    return "";
  }
  return qrMsg;
}

async function resendOrRenewQr(
  env: Env,
  publicUrl: string,
  telefono: string,
  orden: Orden,
  forceRenew: boolean,
): Promise<string> {
  const expires = await getQrExpiresInSec(env, orden);
  const vencido =
    forceRenew ||
    !orden.pey_qr_id ||
    (orden.pago_estado === "PENDIENTE" && expires === 0);

  if (vencido) {
    if (orden.pago_estado === "PAGADO") {
      return `La orden #${orden.id} ya está pagada; no se genera otro QR.`;
    }
    return emitirQr(env, publicUrl, telefono, orden);
  }

  const media = `${publicUrl}/files/qr_${orden.id}.png`;
  const ticketUrl = `${publicUrl}/ticket/${orden.id}`;
  const items = parseOrdenItems(orden);
  const qrMsg =
    formatTicketCaption(
      {
        ordenId: orden.id,
        monto: String(orden.monto),
        items,
        concepto: orden.concepto_pey || undefined,
        vigenciaMin: Math.floor(QR_TTL_SEC / 60),
        peyQrId: orden.pey_qr_id,
      },
      { mediaUrl: media, ticketUrl },
    ) + `\n⏱ Vigencia restante: ${formatMmSs(expires)}`;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    await sendWhatsapp(env, telefono, qrMsg, media);
    return "";
  }
  return qrMsg;
}

/**
 * Tras Sí/No factura:
 * - Sin factura → QR de inmediato
 * - Con factura → primero datos fiscales; el QR se manda al cerrar fiscal
 */
async function afterFacturaChoice(
  env: Env,
  publicUrl: string,
  telefono: string,
  ordenId: number,
  requiere: number,
  items: Item[],
): Promise<string> {
  const concepto = conceptForPey(items, ordenId);
  await env.DB.prepare(
    `UPDATE ordenes SET requiere_factura = ?, concepto_pey = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(requiere, concepto, nowIso(), ordenId)
    .run();

  const orden = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>();
  if (!orden) return "No encontré la orden. Escribe *menú*.";

  // Solo pagar: QR ya
  if (requiere === 0) {
    const qr = await emitirQr(env, publicUrl, telefono, orden);
    const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
    if (hasTwilio) return "";
    return `${qr}\n\nSin factura. Escanea el QR para pagar.`;
  }

  // Con factura: datos primero (el QR espera)
  const savedFiscal = await env.DB.prepare(
    "SELECT * FROM clientes_fiscales WHERE telefono = ?",
  )
    .bind(telefono)
    .first<ClienteFiscal>();

  if (savedFiscal) {
    await env.DB.prepare(
      `UPDATE ordenes SET datos_fiscales_ok = 1, cliente_fiscal_id = ?,
       estado_chat = 'ESPERANDO_DATOS_FISCALES', updated_at = ? WHERE id = ?`,
    )
      .bind(savedFiscal.id, nowIso(), ordenId)
      .run();
    return askSavedFiscalChoice(env, telefono, savedFiscal);
  }

  await env.DB.prepare(
    `UPDATE ordenes SET estado_chat = 'ESPERANDO_DATOS_FISCALES', updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), ordenId)
    .run();
  const orden2 = { ...orden, estado_chat: "ESPERANDO_DATOS_FISCALES", requiere_factura: 1 };
  return askFiscalActions(env, telefono, orden2);
}

/** Tras guardar fiscal (o confirmar guardados): emite el QR si aún no existe. */
async function releaseQrAfterFiscal(
  env: Env,
  publicUrl: string,
  telefono: string,
  ordenId: number,
  preface: string,
): Promise<string> {
  const orden = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>();
  if (!orden) return preface;

  if (orden.pey_qr_id) {
    const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
    if (hasTwilio) {
      await sendWhatsapp(env, telefono, preface);
      return "";
    }
    return preface;
  }

  const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (hasTwilio && preface.trim()) {
    await sendWhatsapp(env, telefono, preface);
  }
  const qr = await emitirQr(env, publicUrl, telefono, orden);
  if (hasTwilio) return "";
  return `${preface}\n\n${qr}`.trim();
}

async function createOrderFromItems(
  env: Env,
  telefono: string,
  items: Item[],
  existing: Orden | null,
): Promise<string> {
  const total = sumItems(items);
  const ts = nowIso();
  if (existing && existing.pago_estado === "PENDIENTE") {
    await env.DB.prepare(
      `UPDATE ordenes SET estado_chat = 'CANCELADO', updated_at = ? WHERE id = ? AND pago_estado = 'PENDIENTE'`,
    )
      .bind(ts, existing.id)
      .run();
  }
  const inserted = await env.DB.prepare(
    `INSERT INTO ordenes
      (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok, estado_chat, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDIENTE', 0, 0, 'ESPERANDO_FACTURA', ?, ?)`,
  )
    .bind(telefono, JSON.stringify(items), total, ts, ts)
    .run();
  const newId = Number(inserted.meta.last_row_id);
  const resumen = items
    .map(
      (i) =>
        `• ${i.cantidad} x ${i.concepto} @ $${i.precio_unitario} = $${i.subtotal}`,
    )
    .join("\n");
  return askFacturaChoice(env, telefono, newId, total, resumen);
}

async function applyFiscalAndContinue(
  env: Env,
  publicUrl: string,
  telefono: string,
  orden: Orden,
  data: Record<string, string>,
): Promise<string> {
  await clearFiscalDraft(env, telefono);
  const cid = await upsertClienteFiscal(env, telefono, data);
  await env.DB.prepare(
    `UPDATE ordenes SET datos_fiscales_ok = 1, cliente_fiscal_id = ?, requiere_factura = 1,
     error_fiscal = NULL, estado_chat = 'ESPERANDO_DATOS_FISCALES', updated_at = ? WHERE id = ?`,
  )
    .bind(cid, nowIso(), orden.id)
    .run();
  await evaluarYTimbrar(env, publicUrl, orden.id);
  const o2 = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(orden.id)
    .first<Orden>();

  if (o2?.pago_estado === "PAGADO" && o2.estado_chat === "ERROR_FISCAL") {
    return `Datos guardados, pero el timbrado falló:\n${o2.error_fiscal}\nCorrige e intenta de nuevo (no se vuelve a cobrar).`;
  }
  if (o2?.facturapi_id) {
    return `✅ Datos listos y factura timbrada (orden #${o2.id}).`;
  }
  if (o2?.pago_estado === "PAGADO") {
    return `✅ Datos guardados para orden #${o2.id}. La factura se timbra enseguida.`;
  }
  const preface =
    `✅ Datos de factura listos (orden #${o2?.id}).\n` +
    `Ahora sí te mando el QR para pagar:`;
  return releaseQrAfterFiscal(env, publicUrl, telefono, orden.id, preface);
}

export async function handleWhatsappMessage(
  env: Env,
  publicUrl: string,
  telefono: string,
  body: string,
  buttonPayload?: string,
  buttonText?: string,
): Promise<string> {
  const interactive = resolveInteractiveId(body, buttonPayload, buttonText);
  const text = (body || "").trim();
  const orden = await getActiveOrder(env, telefono);
  const estado = orden?.estado_chat || "ESPERANDO_PRODUCTOS";

  if (interactive === "MENU" || interactive === "HELP") {
    return askMenu(env, telefono);
  }

  if (interactive === "STATUS" || /^estado|status$/i.test(text)) {
    return replyStatus(env, publicUrl, telefono, orden);
  }

  if (interactive === "HISTORY" || /^historial|ordenes|órdenes$/i.test(text)) {
    return replyHistory(env, telefono);
  }

  if (
    interactive === "QR_RENEW" ||
    /^(nuevo qr|renovar qr|renovar)$/i.test(text)
  ) {
    if (!orden) {
      return askMenu(env, telefono);
    }
    return resendOrRenewQr(env, publicUrl, telefono, orden, true);
  }

  if (
    interactive === "CANCEL" ||
    /^(cancelar|cancelar cobro|anular)$/i.test(text)
  ) {
    if (!orden) {
      return "No hay un cobro activo para cancelar.";
    }
    if (orden.pago_estado === "PAGADO") {
      return `La orden #${orden.id} ya está pagada; no se puede cancelar.`;
    }
    await clearFiscalDraft(env, telefono);
    await env.DB.prepare(
      `UPDATE ordenes
       SET estado_chat = 'CANCELADO', pago_estado = 'CANCELADO', updated_at = ?
       WHERE id = ?`,
    )
      .bind(nowIso(), orden.id)
      .run();
    const msg =
      `Orden #${orden.id} cancelada. Ya no quedará pendiente.\n` +
      `Cuando quieras cobrar otra vez, abre el menú.`;
    const sent = await sendWhatsappQuickReply(env, telefono, msg, [
      { title: "Menú", id: "MENU" },
    ]);
    return sent ? "" : msg;
  }

  // Factura sí/no (antes del catálogo numérico: "1"/"2" son Sí/No aquí)
  if (orden && estado === "ESPERANDO_FACTURA") {
    if (interactive === "FACTURA_SI" || interactive === "FACTURA_NO") {
      const items = JSON.parse(orden.conceptos) as Item[];
      return afterFacturaChoice(
        env,
        publicUrl,
        telefono,
        orden.id,
        interactive === "FACTURA_SI" ? 1 : 0,
        items,
      );
    }
    if (text === "1" || text === "2") {
      const items = JSON.parse(orden.conceptos) as Item[];
      return afterFacturaChoice(
        env,
        publicUrl,
        telefono,
        orden.id,
        text === "1" ? 1 : 0,
        items,
      );
    }
    if (!CATALOG.some((c) => c.id === interactive)) {
      return askFacturaChoice(
        env,
        telefono,
        orden.id,
        orden.monto,
        "Elige una opción en las tarjetas:",
      );
    }
  }

  // Asistente fiscal paso a paso (antes del catálogo: no cancelar a mitad)
  if (orden && isFiscalWizardState(estado)) {
    return advanceFiscalWizard(
      env,
      publicUrl,
      telefono,
      orden,
      estado,
      interactive,
      text,
    );
  }

  // Catálogo (lista Twilio o número 1–N del menú texto)
  let catalogHit = CATALOG.find((c) => c.id === interactive);
  if (
    !catalogHit &&
    /^\d+$/.test(text) &&
    estado !== "ESPERANDO_FACTURA" &&
    !isFiscalWizardState(estado)
  ) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < CATALOG.length) catalogHit = CATALOG[idx];
  }
  if (catalogHit) {
    if (!catalogHit.line) {
      return "Escribe tu pedido así:\n`cantidad concepto precio`\nEjemplo: `2 Cafe 45`";
    }
    const parsed = parseProductLines(catalogHit.line);
    if (parsed.error || !parsed.items) {
      return parsed.error || "No entendí el producto";
    }
    return createOrderFromItems(env, telefono, parsed.items, orden);
  }

  if (
    orden &&
    ["ESPERANDO_DATOS_FISCALES", "ERROR_FISCAL", "ESPERANDO_PAGO"].includes(
      estado,
    )
  ) {
    if (interactive === "QR_RESEND" || /^qr$/i.test(text)) {
      if (!orden.pey_qr_id) {
        return (
          "Todavía no hay QR: primero termina los datos de factura " +
          "(*Sin RFC* o *Sí tengo RFC*)."
        );
      }
      return resendOrRenewQr(env, publicUrl, telefono, orden, false);
    }

    if (
      interactive === "FISCAL_KEEP" ||
      /^(ok|confirmar|sí|si|si, esos|sí, esos)$/i.test(text)
    ) {
      return releaseQrAfterFiscal(
        env,
        publicUrl,
        telefono,
        orden.id,
        "✅ Usamos tus datos guardados. Aquí va el QR para pagar:",
      );
    }

    if (
      interactive === "FISCAL_EDIT" ||
      /^(capturar|cambiar datos|capturar datos|tengo rfc|sí tengo rfc|si tengo rfc|otros|otros datos)$/i.test(
        text,
      )
    ) {
      return startFiscalWizard(env, telefono, orden);
    }

    if (
      interactive === "FISCAL_DEMO" ||
      /^(sin rfc|publico|público|público general|publico general)$/i.test(text)
    ) {
      return applyFiscalAndContinue(env, publicUrl, telefono, orden, DEMO_FISCAL);
    }

    // Compat: si alguien pega la cadena completa, la aceptamos sin anunciarla
    if (text.includes("|")) {
      const { data, error } = parseFiscalData(text);
      if (error || !data) {
        return askFiscalActions(env, telefono, orden);
      }
      return applyFiscalAndContinue(env, publicUrl, telefono, orden, data);
    }

    if (estado === "ESPERANDO_DATOS_FISCALES" || estado === "ERROR_FISCAL") {
      const maybeProducts = parseProductLines(text);
      if (!maybeProducts.error && maybeProducts.items) {
        return createOrderFromItems(env, telefono, maybeProducts.items, orden);
      }
      return askFiscalActions(env, telefono, orden);
    }
  }

  const { items, error } = parseProductLines(text);
  if (error || !items) {
    if (
      !text ||
      text.length < 2 ||
      /hola|menu|menú|ayuda|hi|buenas/i.test(text)
    ) {
      return askMenu(env, telefono);
    }
    return (
      (error || "No entendí el pedido.") +
      "\n\nUsa el menú (*estado*, *historial*, productos) o escribe:\n`cantidad concepto precio`"
    );
  }

  return createOrderFromItems(env, telefono, items, orden);
}
