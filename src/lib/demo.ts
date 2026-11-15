import type { Env, Orden } from "../types";
import { evaluarYTimbrar } from "./facturapi";
import { nowIso } from "./parse";
import {
  crearQrPey,
  extractQrPayload,
  storeQrPng,
} from "./pey";

/** Teléfono sintético: no requiere join al Twilio Sandbox. */
export const DEMO_TELEFONO = "whatsapp:+5215500000099";

const DEMO_FISCAL = {
  rfc: "URE180429TM6",
  razon_social: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
  codigo_postal: "86991",
  regimen: "601",
  uso_cfdi: "G03",
};

const DEMO_ITEMS = [
  {
    cantidad: "1",
    concepto: "Demo CoDiPey abarrotes",
    precio_unitario: "25.00",
    subtotal: "25.00",
  },
];

async function ensureDemoFiscal(env: Env): Promise<number> {
  const existing = await env.DB.prepare(
    "SELECT id FROM clientes_fiscales WHERE telefono = ?",
  )
    .bind(DEMO_TELEFONO)
    .first<{ id: number }>();
  const ts = nowIso();
  if (existing) {
    await env.DB.prepare(
      `UPDATE clientes_fiscales
       SET rfc = ?, razon_social = ?, codigo_postal = ?, regimen = ?, uso_cfdi = ?, updated_at = ?
       WHERE telefono = ?`,
    )
      .bind(
        DEMO_FISCAL.rfc,
        DEMO_FISCAL.razon_social,
        DEMO_FISCAL.codigo_postal,
        DEMO_FISCAL.regimen,
        DEMO_FISCAL.uso_cfdi,
        ts,
        DEMO_TELEFONO,
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
      DEMO_TELEFONO,
      DEMO_FISCAL.rfc,
      DEMO_FISCAL.razon_social,
      DEMO_FISCAL.codigo_postal,
      DEMO_FISCAL.regimen,
      DEMO_FISCAL.uso_cfdi,
      ts,
    )
    .run();
  return Number(res.meta.last_row_id);
}

/** Crea orden pendiente + QR CoDi (sin WhatsApp). */
export async function simularCobroDemo(
  env: Env,
): Promise<{ orden: Orden; qr_url: string }> {
  const fiscalId = await ensureDemoFiscal(env);
  const ts = nowIso();
  const monto = "25.00";
  const concepto = "Demo CoDiPey";
  const inserted = await env.DB.prepare(
    `INSERT INTO ordenes
      (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
       cliente_fiscal_id, estado_chat, concepto_pey, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDIENTE', 1, 1, ?, 'ESPERANDO_PAGO', ?, ?, ?)`,
  )
    .bind(
      DEMO_TELEFONO,
      JSON.stringify(DEMO_ITEMS),
      monto,
      fiscalId,
      concepto,
      ts,
      ts,
    )
    .run();
  const ordenId = Number(inserted.meta.last_row_id);

  const peyData = await crearQrPey(env, ordenId, Number(monto), concepto);
  const qrPayload = extractQrPayload(peyData);
  const peyQrId =
    String(peyData.id || peyData.qrId || peyData.uuid || "") || null;
  await storeQrPng(env, ordenId, qrPayload, {
    items: DEMO_ITEMS,
    monto,
    concepto,
    peyQrId,
  });
  await env.DB.prepare(
    `UPDATE ordenes SET pey_qr_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(peyQrId, nowIso(), ordenId)
    .run();

  const orden = (await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>())!;
  return { orden, qr_url: `/files/qr_${ordenId}.png` };
}

/** Liquida como pey webhook + intenta timbrar CFDI. */
export async function simularPagoDemo(
  env: Env,
  publicUrl: string,
  ordenId: number,
): Promise<{ orden: Orden; message: string }> {
  const orden = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>();
  if (!orden) {
    const err = new Error("Orden no encontrada");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (orden.pago_estado === "PAGADO") {
    return { orden, message: "Ya estaba pagada" };
  }
  if (orden.pago_estado === "CANCELADO" || orden.estado_chat === "CANCELADO") {
    const err = new Error("La orden está cancelada");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }

  const txId = `demo_tx_${ordenId}_${Date.now()}`;
  const nextEstado =
    Number(orden.requiere_factura) === 1 ? orden.estado_chat : "COMPLETADO";
  await env.DB.prepare(
    `UPDATE ordenes
     SET pago_estado = 'PAGADO', pey_transaction_id = ?, estado_chat = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(txId, nextEstado, nowIso(), ordenId)
    .run();

  const updated = await evaluarYTimbrar(env, publicUrl, ordenId);
  const final =
    updated ||
    (await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
      .bind(ordenId)
      .first<Orden>())!;
  const stamped = Boolean(final.facturapi_id);
  return {
    orden: final,
    message: stamped
      ? "Pago liquidado y CFDI timbrado"
      : "Pago liquidado (CFDI pendiente o no requerido)",
  };
}
