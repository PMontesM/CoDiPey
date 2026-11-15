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
import { sendWhatsapp } from "./twilio";

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
    let detail = String(err);
    if (status === 401 || status === 403) {
      detail = `pey rechazó la API key (HTTP ${status}). Revisa PEY_API_KEY.`;
    } else if (status) {
      detail = `HTTP ${status}`;
    }
    const msg = `⚠️ No pudimos generar el QR CoDi.\n${detail}\nReintenta enviando de nuevo tus productos.`;
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

  let fiscalMsg: string;
  if (requiere === 1) {
    if (savedFiscal) {
      await env.DB.prepare(
        `UPDATE ordenes SET datos_fiscales_ok = 1, cliente_fiscal_id = ?, pey_qr_id = ?,
         estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
      )
        .bind(savedFiscal.id, peyQrId, nowIso(), ordenId)
        .run();
      fiscalMsg = `Usaremos tus datos fiscales guardados (${savedFiscal.rfc}). Si deseas cambiarlos, envía:\nRFC | Razón Social | CP | Régimen | UsoCFDI`;
    } else {
      await env.DB.prepare(
        `UPDATE ordenes SET pey_qr_id = ?, estado_chat = 'ESPERANDO_DATOS_FISCALES', updated_at = ? WHERE id = ?`,
      )
        .bind(peyQrId, nowIso(), ordenId)
        .run();
      fiscalMsg =
        "Para facturar envía tus datos:\nRFC | Razón Social | CP | Régimen | UsoCFDI\nEjemplo SAT: XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03";
    }
  } else {
    await env.DB.prepare(
      `UPDATE ordenes SET pey_qr_id = ?, estado_chat = 'ESPERANDO_PAGO', updated_at = ? WHERE id = ?`,
    )
      .bind(peyQrId, nowIso(), ordenId)
      .run();
    fiscalMsg = "Sin factura. Escanea el QR CoDi para pagar.";
  }

  const msg = `Orden #${ordenId} por $${monto} MXN.\nConcepto CoDi: ${concepto}\nEscanea el QR (válido 10 min):\n${media}\n\n${fiscalMsg}`;
  await sendWhatsapp(env, telefono, msg, media);
  return msg;
}

export async function handleWhatsappMessage(
  env: Env,
  publicUrl: string,
  telefono: string,
  body: string,
): Promise<string> {
  const text = (body || "").trim();
  const orden = await getActiveOrder(env, telefono);
  const estado = orden?.estado_chat || "ESPERANDO_PRODUCTOS";

  if (
    orden &&
    ["ESPERANDO_DATOS_FISCALES", "ERROR_FISCAL", "ESPERANDO_PAGO"].includes(
      estado,
    )
  ) {
    if (text.includes("|")) {
      const { data, error } = parseFiscalData(text);
      if (error || !data) return error || "Datos inválidos";
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
    if (estado === "ESPERANDO_DATOS_FISCALES" || estado === "ERROR_FISCAL") {
      return "Para facturar envía:\nRFC | Razón Social | CP | Régimen | UsoCFDI";
    }
  }

  if (orden && estado === "ESPERANDO_FACTURA") {
    if (text !== "1" && text !== "2") {
      return "Responde *1* para factura o *2* si no la necesitas.";
    }
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

  const { items, error } = parseProductLines(text);
  if (error || !items) return error || "No entendí";

  const total = sumItems(items);
  const ts = nowIso();
  if (orden && orden.pago_estado === "PENDIENTE") {
    await env.DB.prepare(
      `UPDATE ordenes SET estado_chat = 'CANCELADO', updated_at = ? WHERE id = ? AND pago_estado = 'PENDIENTE'`,
    )
      .bind(ts, orden.id)
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
  return `Orden #${newId}\n${resumen}\n\n*Total: $${total} MXN*\n\n¿Requieres factura CFDI 4.0?\nResponde *1* = Sí  |  *2* = No`;
}
