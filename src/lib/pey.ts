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

/**
 * Link de pago de pey, si la respuesta lo trae.
 * El campo no está documentado en docs.pey.mx, así que se buscan los nombres
 * habituales (primero los explícitos de pago, al final `url`/`link`) y solo
 * se acepta un http(s). Si pey no devuelve link, regresa null y el mensaje
 * queda como antes: solo QR + link del ticket.
 */
const PAYMENT_LINK_KEYS = [
  "paymentUrl",
  "paymentLink",
  "payUrl",
  "checkoutUrl",
  "payment_url",
  "payment_link",
  "url",
  "link",
];

export function extractPaymentLink(
  peyData: Record<string, unknown>,
): string | null {
  const candidates: unknown[] = [peyData];
  const nested = peyData.data;
  if (nested && typeof nested === "object") candidates.push(nested);
  for (const obj of candidates) {
    const rec = obj as Record<string, unknown>;
    for (const key of PAYMENT_LINK_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) {
        return v.trim();
      }
    }
  }
  return null;
}

/**
 * Guarda el link de pago de forma best-effort: si la migración 0004 aún no
 * se aplicó en esa base, no debe romper el flujo del QR.
 */
export async function savePeyPaymentUrl(
  env: Env,
  ordenId: number,
  url: string | null,
): Promise<void> {
  if (!url) return;
  try {
    await env.DB.prepare(
      "UPDATE ordenes SET pey_payment_url = ? WHERE id = ?",
    )
      .bind(url, ordenId)
      .run();
  } catch (err) {
    console.log(`[pey] no se guardó el link de pago: ${String(err)}`);
  }
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
