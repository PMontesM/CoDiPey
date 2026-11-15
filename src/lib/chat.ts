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
import {
  resolveInteractiveId,
  sendWhatsapp,
  sendWhatsappList,
  sendWhatsappQuickReply,
} from "./twilio";

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
    `🧾 *Factura* — orden #${orden.id}\n\n` +
    `En la mayoría de las tiendas basta con *Sin RFC*.\n` +
    `Si el cliente trae RFC, lo llenamos juntitos, una pregunta a la vez.`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Sin RFC", id: "FISCAL_DEMO" },
    { title: "Sí tengo RFC", id: "FISCAL_EDIT" },
    { title: "Reenviar QR", id: "QR_RESEND" },
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
    `*${saved.rfc}* · ${corto}`;
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
  if (interactive === "MENU" || interactive === "HELP") {
    await clearFiscalDraft(env, telefono);
    return askMenu(env, telefono);
  }
  if (interactive === "QR_RESEND" || interactive === "QR_RENEW") {
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
    draft.rfc = normalizeRfc(text);
    await saveFiscalDraft(env, telefono, draft);
    await setOrdenEstado(env, orden.id, "ESPERANDO_FISCAL_NOMBRE");
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
    await clearFiscalDraft(env, telefono);
    return applyFiscalAndContinue(env, publicUrl, telefono, orden, {
      rfc: draft.rfc,
      razon_social: draft.razon_social,
      codigo_postal: draft.codigo_postal,
      regimen: draft.regimen,
      uso_cfdi: draft.uso_cfdi,
    });
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
    body += `\nQR: ${publicUrl}/files/qr_${orden.id}.png`;
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
  await storeQrPng(env, orden.id, qrPayload);
  await env.DB.prepare(
    `UPDATE ordenes SET pey_qr_id = ?, concepto_pey = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(peyQrId, concepto, nowIso(), orden.id)
    .run();

  const media = `${publicUrl}/files/qr_${orden.id}.png`;
  const qrMsg =
    `🔲 *QR CoDi* orden #${orden.id} ($${orden.monto} MXN)\n` +
    `${concepto}\nVálido ${Math.floor(QR_TTL_SEC / 60)} min — escanéalo con tu banca.\n` +
    `Si no ves la imagen: ${media}`;

  const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (hasTwilio) {
    await sendWhatsapp(env, telefono, qrMsg, media);
    if (!opts?.announceOnly) {
      await sendWhatsappQuickReply(
        env,
        telefono,
        "Cuando venza la vigencia (~10 min) el banco ya no podrá pagar este QR. Usa *Nuevo QR* o revisa el *Estado*.",
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
  const qrMsg =
    `🔲 QR CoDi orden #${orden.id} ($${orden.monto} MXN)\n` +
    `Vigencia restante: ${formatMmSs(expires)}\n` +
    `Si no ves la imagen: ${media}`;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    await sendWhatsapp(env, telefono, qrMsg, media);
    return "";
  }
  return qrMsg;
}

async function crearQrYAvanzar(
  env: Env,
  publicUrl: string,
  telefono: string,
  ordenId: number,
  requiere: number,
  items: Item[],
  monto: string,
): Promise<string> {
  const concepto = conceptForPey(items, ordenId);
  await env.DB.prepare(
    `UPDATE ordenes SET requiere_factura = ?, concepto_pey = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(requiere, concepto, nowIso(), ordenId)
    .run();

  let peyData: Record<string, unknown>;
  try {
    peyData = await crearQrPey(env, ordenId, Number(monto), concepto);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const raw = err instanceof Error ? err.message : String(err);
    let detail = raw;
    if (status === 401 || status === 403) {
      detail =
        `pey rechazó la API key (HTTP ${status}). ` +
        `Revisa PEY_API_KEY en Cloudflare Secrets (sin espacios) y CoDi en portal.mipey.mx.\n${raw}`;
    }
    const msg = `⚠️ No pudimos generar el QR CoDi.\n${detail}\nReintenta desde el menú de productos.`;
    await sendWhatsapp(env, telefono, msg);
    await env.DB.prepare(
      `UPDATE ordenes SET estado_chat = 'CANCELADO', updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), ordenId)
      .run();
    return msg;
  }

  const qrPayload = extractQrPayload(peyData);
  const peyQrId = String(peyData.id || peyData.qrId || peyData.uuid || "") || null;
  await storeQrPng(env, ordenId, qrPayload);
  const media = `${publicUrl}/files/qr_${ordenId}.png`;

  const savedFiscal = await env.DB.prepare(
    "SELECT * FROM clientes_fiscales WHERE telefono = ?",
  )
    .bind(telefono)
    .first<ClienteFiscal>();

  const qrMsg =
    `🔲 *QR CoDi* orden #${ordenId} ($${monto} MXN)\n` +
    `${concepto}\nVálido ${Math.floor(QR_TTL_SEC / 60)} min — escanéalo con tu banca.\n` +
    `Si no ves la imagen: ${media}`;

  const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (hasTwilio) {
    await sendWhatsapp(env, telefono, qrMsg, media);
  }

  if (requiere === 1) {
    if (savedFiscal) {
      await env.DB.prepare(
        `UPDATE ordenes SET datos_fiscales_ok = 1, cliente_fiscal_id = ?, pey_qr_id = ?,
         estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
      )
        .bind(savedFiscal.id, peyQrId, nowIso(), ordenId)
        .run();
      const ask = await askSavedFiscalChoice(env, telefono, savedFiscal);
      if (hasTwilio) return "";
      return `${qrMsg}\n\n${ask}`;
    }
    await env.DB.prepare(
      `UPDATE ordenes SET pey_qr_id = ?, estado_chat = 'ESPERANDO_DATOS_FISCALES', updated_at = ? WHERE id = ?`,
    )
      .bind(peyQrId, nowIso(), ordenId)
      .run();
    const orden = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
      .bind(ordenId)
      .first<Orden>();
    if (orden) {
      const ask = await askFiscalActions(env, telefono, orden);
      if (hasTwilio) return "";
      return `${qrMsg}\n\n${ask}`;
    }
  } else {
    await env.DB.prepare(
      `UPDATE ordenes SET pey_qr_id = ?, estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
    )
      .bind(peyQrId, nowIso(), ordenId)
      .run();
    const okMsg =
      "Sin factura. Escanea el QR CoDi para pagar.\nSi vence (~10 min), pide *Nuevo QR*.";
    if (hasTwilio) {
      await sendWhatsappQuickReply(env, telefono, okMsg, [
        { title: "Estado", id: "STATUS" },
        { title: "Nuevo QR", id: "QR_RENEW" },
        { title: "Menú", id: "MENU" },
      ]);
      return "";
    }
    return `${qrMsg}\n\n${okMsg}`;
  }

  return hasTwilio ? "" : qrMsg;
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
     error_fiscal = NULL, estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
  )
    .bind(cid, nowIso(), orden.id)
    .run();
  await evaluarYTimbrar(env, publicUrl, orden.id);
  const o2 = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(orden.id)
    .first<Orden>();
  if (o2?.facturapi_id) {
    return `✅ Datos fiscales guardados y factura timbrada para orden #${o2.id}.`;
  }
  if (o2?.pago_estado === "PAGADO" && o2.estado_chat === "ERROR_FISCAL") {
    return `Datos guardados, pero el timbrado falló:\n${o2.error_fiscal}\nCorrige e intenta de nuevo (no se vuelve a cobrar).`;
  }
  return `✅ Datos fiscales guardados para orden #${o2?.id}. Cuando se confirme el pago CoDi, timbraremos automáticamente.`;
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

  // Factura sí/no (antes del catálogo numérico: "1"/"2" son Sí/No aquí)
  if (orden && estado === "ESPERANDO_FACTURA") {
    if (interactive === "FACTURA_SI" || interactive === "FACTURA_NO") {
      const items = JSON.parse(orden.conceptos) as Item[];
      return crearQrYAvanzar(
        env,
        publicUrl,
        telefono,
        orden.id,
        interactive === "FACTURA_SI" ? 1 : 0,
        items,
        orden.monto,
      );
    }
    if (text === "1" || text === "2") {
      const items = JSON.parse(orden.conceptos) as Item[];
      return crearQrYAvanzar(
        env,
        publicUrl,
        telefono,
        orden.id,
        text === "1" ? 1 : 0,
        items,
        orden.monto,
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
      return resendOrRenewQr(env, publicUrl, telefono, orden, false);
    }

    if (
      interactive === "FISCAL_KEEP" ||
      /^(ok|confirmar|sí|si|si, esos|sí, esos)$/i.test(text)
    ) {
      return `Listo, usamos esos datos. Escanea el QR (vale ~10 min). Si se vence, pide *Nuevo QR*.`;
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
