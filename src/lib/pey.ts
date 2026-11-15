import type { Env } from "../types";
import { putBlob } from "./blobs";

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
      expiration: 600,
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

export async function storeQrPng(
  env: Env,
  ordenId: number,
  qrPayload: string,
): Promise<string> {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrPayload)}`;
  const img = await fetch(url);
  if (!img.ok) throw new Error(`QR image HTTP ${img.status}`);
  const bytes = await img.arrayBuffer();
  const key = `qr_${ordenId}.png`;
  await putBlob(env, key, bytes, "image/png");
  return key;
}
