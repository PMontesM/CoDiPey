import type { Env } from "../types";
import { putBlob } from "./blobs";

export async function crearQrPey(
  env: Env,
  ordenId: number,
  amount: number,
  concept: string,
): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.pey.mx/codi/qr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PEY_API_KEY}`,
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
    const err = new Error(`pey HTTP ${res.status}: ${text.slice(0, 300)}`);
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
