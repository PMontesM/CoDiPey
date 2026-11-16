import { getIdentity } from "../../cursor/identity";
import type { Env } from "../types";

const FILE_TTL_SEC = 7 * 24 * 3600;
const WEBHOOK_TOLERANCE_SEC = 300;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i)! ^ b.charCodeAt(i)!;
  return diff === 0;
}

async function hmacSha256(
  keyBytes: Uint8Array,
  data: string | Uint8Array,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign("HMAC", cryptoKey, payload);
}

async function hmacSha1Base64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return bytesToB64(sig);
}

function decodeWebhookSecret(secret: string): Uint8Array {
  const raw = secret.trim().replace(/^whsec_/i, "");
  try {
    return b64ToBytes(raw);
  } catch {
    return new TextEncoder().encode(secret.trim());
  }
}

function signingSecret(env: Env): string {
  return (
    (env.FILE_SIGNING_SECRET || "").trim() ||
    (env.ADMIN_API_SECRET || "").trim() ||
    (env.PEY_WEBHOOK_SECRET || "").trim()
  );
}

/**
 * Operador: identidad Cursor verificada (no simulada) o Bearer / x-admin-token.
 * Si ADMIN_API_SECRET no está configurado, el Worker es single-tenant abierto
 * (panel real contra D1). Con secret definido, exige token o sesión Cursor.
 */
export async function requireOperator(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const identity = await getIdentity(request);
  if (identity.verified && !identity.simulated) {
    return null;
  }
  const secret = (env.ADMIN_API_SECRET || "").trim();
  if (!secret) {
    return null;
  }
  const auth = request.headers.get("authorization") || "";
  const headerToken = request.headers.get("x-admin-token") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (bearer === secret || headerToken === secret) {
    return null;
  }
  return Response.json(
    { detail: "No autorizado: configura el token de operador en el panel" },
    { status: 401, headers: { "cache-control": "private, no-store" } },
  );
}

/**
 * Verifica Twilio X-Twilio-Signature (HMAC-SHA1 del URL + params).
 * Fail-closed: sin TWILIO_AUTH_TOKEN no se acepta el webhook.
 */
export async function verifyTwilioSignature(
  env: Env,
  request: Request,
  params: Record<string, string>,
): Promise<boolean> {
  const token = (env.TWILIO_AUTH_TOKEN || "").trim();
  if (!token) return false;
  const header = request.headers.get("x-twilio-signature") || "";
  if (!header) return false;
  const url = new URL(request.url);
  // Twilio firma la URL pública exacta; PUBLIC_URL fija evita mismatch detrás de proxies.
  const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const fullUrl = base
    ? `${base}${url.pathname}${url.search}`
    : url.toString();
  const keys = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of keys) data += k + params[k];
  const expected = await hmacSha1Base64(token, data);
  return timingSafeEqualStr(expected, header);
}

/**
 * Standard Webhooks (pey): webhook-id / webhook-timestamp / webhook-signature.
 * Fail-closed sin PEY_WEBHOOK_SECRET.
 */
export async function verifyPeyWebhook(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<boolean> {
  const secret = (env.PEY_WEBHOOK_SECRET || "").trim();
  if (!secret) return false;
  const msgId = request.headers.get("webhook-id") || "";
  const timestamp = request.headers.get("webhook-timestamp") || "";
  const signatureHeader = request.headers.get("webhook-signature") || "";
  if (!msgId || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SEC) return false;

  const key = decodeWebhookSecret(secret);
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expectedBytes = new Uint8Array(await hmacSha256(key, signedContent));
  const expectedB64 = bytesToB64(expectedBytes);

  return signatureHeader.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) return false;
    try {
      const got = b64ToBytes(sig);
      if (got.length !== expectedBytes.length) return false;
      let diff = 0;
      for (let i = 0; i < got.length; i++) diff |= got[i]! ^ expectedBytes[i]!;
      return diff === 0;
    } catch {
      return timingSafeEqualStr(sig, expectedB64);
    }
  });
}

export function isProtectedFileKey(key: string): boolean {
  return /^factura_\d+\.(pdf|xml)$/i.test(key);
}

export async function signFileAccess(
  env: Env,
  key: string,
  ttlSec = FILE_TTL_SEC,
): Promise<{ exp: number; sig: string } | null> {
  const secret = signingSecret(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const mac = await hmacSha256(
    new TextEncoder().encode(secret),
    `${key}.${exp}`,
  );
  return { exp, sig: bytesToHex(mac) };
}

export async function signedFilePath(
  env: Env,
  publicUrl: string,
  key: string,
): Promise<string> {
  const base = publicUrl.replace(/\/$/, "");
  const signed = await signFileAccess(env, key);
  if (!signed) return `${base}/files/${key}`;
  return `${base}/files/${key}?exp=${signed.exp}&sig=${signed.sig}`;
}

export async function verifyFileAccess(
  env: Env,
  key: string,
  expRaw: string | null,
  sig: string | null,
): Promise<boolean> {
  if (!isProtectedFileKey(key)) return true;
  const secret = signingSecret(env);
  if (!secret) return false;
  const exp = Number(expRaw || "");
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  if (!sig) return false;
  const mac = await hmacSha256(
    new TextEncoder().encode(secret),
    `${key}.${exp}`,
  );
  return timingSafeEqualStr(bytesToHex(mac), sig.toLowerCase());
}

/** Helpers de test / firma saliente. */
export async function signTwilioRequestForTest(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return hmacSha1Base64(authToken, data);
}

export async function signPeyWebhookForTest(
  secret: string,
  msgId: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = decodeWebhookSecret(secret);
  const mac = await hmacSha256(key, `${msgId}.${timestamp}.${rawBody}`);
  return `v1,${bytesToB64(mac)}`;
}
