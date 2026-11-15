import type { ClienteFiscal, Env, Item, Orden } from "../types";
import { evaluarYTimbrar } from "./facturapi";
import {
  conceptForPey,
  nowIso,
  parseFiscalData,
  parseProductLines,
  sumItems,
} from "./parse";
import { crearQrPey, extractQrPayload, storeQrPng } from "./pey";
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

async function askMenu(env: Env, telefono: string): Promise<string> {
  const body =
    "🛒 *Cobro CoDi + CFDI 4.0*\nElige un producto del menú o escribe tu pedido:\n`cantidad concepto precio`\nEj: `1 Prueba CoDi 0.01`";
  const sent = await sendWhatsappList(env, telefono, body, "Ver productos", CATALOG.map((c) => ({
    id: c.id,
    item: c.item,
    description: c.description,
  })));
  if (sent) return "";
  return (
    `${body}\n\n` +
    CATALOG.map((c, i) => `${i + 1}) ${c.item}`).join("\n")
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
    `✅ *Orden #${ordenId}*\n${resumen}\n\n*Total: $${total} MXN*\n\n¿Requieres factura CFDI 4.0?`;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Sí, factura", id: "FACTURA_SI" },
    { title: "Solo pagar", id: "FACTURA_NO" },
  ]);
  if (sent) return "";
  return `${body}\n\nResponde *1* = Sí  |  *2* = No`;
}

async function askFiscalActions(
  env: Env,
  telefono: string,
  orden: Orden,
  publicUrl: string,
): Promise<string> {
  const qrHint = orden.pey_qr_id
    ? `\nQR: ${publicUrl}/files/qr_${orden.id}.png`
    : "";
  const body =
    `🧾 *Datos fiscales* (orden #${orden.id})\n` +
    `Elige una tarjeta o envía:\n` +
    `RFC | Razón Social | CP | Régimen | UsoCFDI` +
    qrHint;
  const sent = await sendWhatsappQuickReply(env, telefono, body, [
    { title: "Público general", id: "FISCAL_DEMO" },
    { title: "Reenviar QR", id: "QR_RESEND" },
    { title: "Menú", id: "MENU" },
  ]);
  if (sent) return "";
  return (
    `${body}\n\n` +
    `Ejemplo: XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03\n` +
    `O responde *qr* para reenviar el código.`
  );
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
    `${concepto}\nVálido 10 min — escanéalo con tu banca.\n` +
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
      const fiscalMsg =
        `Usaremos tus datos fiscales guardados (*${savedFiscal.rfc}*).\n` +
        `Si quieres cambiarlos, usa la tarjeta o envía la cadena fiscal.`;
      if (hasTwilio) {
        await sendWhatsappQuickReply(env, telefono, fiscalMsg, [
          { title: "Público general", id: "FISCAL_DEMO" },
          { title: "Reenviar QR", id: "QR_RESEND" },
        ]);
        return "";
      }
      return `${qrMsg}\n\n${fiscalMsg}`;
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
      const ask = await askFiscalActions(env, telefono, orden, publicUrl);
      if (hasTwilio) return "";
      return `${qrMsg}\n\n${ask}`;
    }
  } else {
    await env.DB.prepare(
      `UPDATE ordenes SET pey_qr_id = ?, estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
    )
      .bind(peyQrId, nowIso(), ordenId)
      .run();
    const okMsg = "Sin factura. Escanea el QR CoDi para pagar.";
    if (hasTwilio) {
      await sendWhatsappQuickReply(env, telefono, okMsg, [
        { title: "Reenviar QR", id: "QR_RESEND" },
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

  // Menú / ayuda siempre disponibles
  if (interactive === "MENU" || interactive === "HELP") {
    return askMenu(env, telefono);
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
    // compat texto 1/2
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
    // Si eligió otro producto del list-picker, sigue al catálogo abajo
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

  // Catálogo (lista Twilio o número 1–N del menú texto)
  let catalogHit = CATALOG.find((c) => c.id === interactive);
  if (!catalogHit && /^\d+$/.test(text) && estado !== "ESPERANDO_FACTURA") {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < CATALOG.length) catalogHit = CATALOG[idx];
  }
  if (catalogHit) {
    if (!catalogHit.line) {
      return "Escribe tu pedido así:\n`cantidad concepto precio`\nEjemplo: `2 Cafe 45`";
    }
    const parsed = parseProductLines(catalogHit.line);
    if (parsed.error || !parsed.items) return parsed.error || "No entendí el producto";
    return createOrderFromItems(env, telefono, parsed.items, orden);
  }

  if (
    orden &&
    ["ESPERANDO_DATOS_FISCALES", "ERROR_FISCAL", "ESPERANDO_PAGO"].includes(
      estado,
    )
  ) {
    if (interactive === "QR_RESEND" && orden.pey_qr_id) {
      const media = `${publicUrl}/files/qr_${orden.id}.png`;
      const qrMsg =
        `🔲 QR CoDi orden #${orden.id} ($${orden.monto} MXN)\n` +
        `Si no ves la imagen: ${media}`;
      if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
        await sendWhatsapp(env, telefono, qrMsg, media);
        return "";
      }
      return qrMsg;
    }

    if (interactive === "FISCAL_DEMO") {
      return applyFiscalAndContinue(env, publicUrl, telefono, orden, DEMO_FISCAL);
    }

    if (text.includes("|")) {
      const { data, error } = parseFiscalData(text);
      if (error || !data) return error || "Datos inválidos";
      return applyFiscalAndContinue(env, publicUrl, telefono, orden, data);
    }

    if (estado === "ESPERANDO_DATOS_FISCALES" || estado === "ERROR_FISCAL") {
      const maybeProducts = parseProductLines(text);
      if (!maybeProducts.error && maybeProducts.items) {
        return createOrderFromItems(env, telefono, maybeProducts.items, orden);
      }
      return askFiscalActions(env, telefono, orden, publicUrl);
    }
  }

  // Productos en texto libre
  const { items, error } = parseProductLines(text);
  if (error || !items) {
    // Primera interacción / mensaje raro → menú con tarjetas
    if (!text || text.length < 2 || /hola|menu|menú|ayuda|hi|buenas/i.test(text)) {
      return askMenu(env, telefono);
    }
    return (
      (error || "No entendí el pedido.") +
      "\n\nUsa el menú de productos o escribe:\n`cantidad concepto precio`"
    );
  }

  return createOrderFromItems(env, telefono, items, orden);
}
