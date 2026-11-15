import type { Env, Item } from "../types";
import { putBlob } from "./blobs";
import { renderTicketPng, type TicketMeta } from "./ticket";

/** Vigencia CoDi en pey (segundos). */
export const QR_TTL_SEC = 600;

export async function getQrExpiresInSec(
  env: Env,
  orden: { id: number; pago_estado: string; pey_qr_id: string | null },
): Promise<number> {
  if (orden.pago_estado !== "PENDIENTE" || !orden.pey_qr_id) return 0;
  const blob = await env.DB.prepare(
    "SELECT updated_at FROM blobs WHERE key = ?",
  )
    .bind(`qr_${orden.id}.png`)
    .first<{ updated_at: string }>();
  if (!blob?.updated_at) return 0;
  const elapsed = (Date.now() - Date.parse(blob.updated_at)) / 1000;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.floor(QR_TTL_SEC - elapsed));
}

export async function crearQrPey(
  env: Env,
  ordenId: number,
  amount: number,
  concept: string,
): Promise<Record<string, unknown>> {
  // Evita 403 por espacios/saltos si la key se pegó mal en el dashboard
  const apiKey = (env.PEY_API_KEY || "").trim().replace(/^Bearer\s+/i, "");
  const res = await fetch("https://api.pey.mx/codi/qr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      amount,
      concept: concept.slice(0, 40),
      expiration: QR_TTL_SEC,
      numRef: String(ordenId),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        message?: string;
        error?: { message?: string };
      };
      detail = j.error?.message || j.message || detail;
    } catch {
      /* keep text */
    }
    const err = new Error(`pey HTTP ${res.status}: ${detail}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as Record<string, unknown>;
}

export function extractQrPayload(peyData: Record<string, unknown>): string {
  let qrPayload: unknown =
    peyData.qr ?? peyData.qrString ?? peyData.payload ?? peyData.data ?? peyData;
  if (qrPayload && typeof qrPayload === "object") {
    const obj = qrPayload as Record<string, unknown>;
    qrPayload = obj.qr ?? obj.qrString ?? JSON.stringify(obj);
  }
  return String(qrPayload);
}

export type StoreQrOptions = {
  items?: Item[];
  monto?: string;
  concepto?: string;
  peyQrId?: string | null;
};

/**
 * Genera QR CoDi:
 * - `qr_{id}.png` → ticket térmico (WhatsApp media)
 * - `qr_code_{id}.png` → QR suelto (página HTML /ticket/:id para escanear grande)
 * Si el render del ticket falla, el ticket cae al QR plano.
 */
export async function storeQrPng(
  env: Env,
  ordenId: number,
  qrPayload: string,
  opts?: StoreQrOptions,
): Promise<string> {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(qrPayload)}`;
  const img = await fetch(url);
  if (!img.ok) throw new Error(`QR image HTTP ${img.status}`);
  const qrBytes = await img.arrayBuffer();
  const key = `qr_${ordenId}.png`;
  const rawKey = `qr_code_${ordenId}.png`;
  await putBlob(env, rawKey, qrBytes, "image/png");

  let bytes = qrBytes;
  if (opts?.monto) {
    const meta: TicketMeta = {
      ordenId,
      monto: opts.monto,
      items: opts.items || [],
      concepto: opts.concepto,
      vigenciaMin: Math.floor(QR_TTL_SEC / 60),
      peyQrId: opts.peyQrId,
    };
    try {
      bytes = await renderTicketPng(qrBytes, meta);
    } catch (err) {
      console.log(`[ticket] render failed, plain QR: ${String(err)}`);
    }
  }

  await putBlob(env, key, bytes, "image/png");
  return key;
}
