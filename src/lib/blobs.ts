import type { Env } from "../types";
import { nowIso } from "./parse";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // chunk to avoid call stack / argument limits
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function coerceToArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data == null) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    const copy = new Uint8Array(v.byteLength);
    copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return copy.buffer;
  }
  if (Array.isArray(data)) {
    return Uint8Array.from(data.map((n) => Number(n))).buffer;
  }
  if (typeof data === "string") {
    // Legacy: "137,80,78,71,..."
    if (data.includes(",") && /^\d/.test(data.trim())) {
      return Uint8Array.from(data.split(",").map((n) => Number(n.trim()))).buffer;
    }
    // Hex from SELECT hex(data)
    if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) {
      const out = new Uint8Array(data.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      }
      return out.buffer;
    }
    try {
      return fromBase64(data);
    } catch {
      return null;
    }
  }
  // D1 sometimes returns { type: 'Buffer', data: number[] } shaped objects
  if (typeof data === "object" && data !== null && "data" in data) {
    return coerceToArrayBuffer((data as { data: unknown }).data);
  }
  return null;
}

export async function putBlob(
  env: Env,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  // TEXT base64 — portable across D1 read paths
  await env.DB.prepare(
    `INSERT INTO blobs (key, content_type, data, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       content_type = excluded.content_type,
       data = excluded.data,
       updated_at = excluded.updated_at`,
  )
    .bind(key, contentType, toBase64(data), nowIso())
    .run();
}

export async function getBlob(
  env: Env,
  key: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  // Prefer hex() so BLOBs always come back as a string we can decode
  const row = await env.DB.prepare(
    `SELECT content_type, data, hex(data) AS hexdata FROM blobs WHERE key = ?`,
  )
    .bind(key)
    .first<{ content_type: string; data: unknown; hexdata: string }>();

  if (!row) return null;

  let buf = coerceToArrayBuffer(row.data);

  // If stored as raw BLOB, hexdata is the reliable path
  if (!buf || buf.byteLength === 0) {
    buf = coerceToArrayBuffer(row.hexdata);
  }

  // If stored as base64 TEXT, hex(data) is hex of ascii — detect PNG/PDF magic
  if (buf && buf.byteLength > 0) {
    const head = new Uint8Array(buf.slice(0, 4));
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isPdf = head[0] === 0x25 && head[1] === 0x50; // %P
    const isXml = head[0] === 0x3c; // <
    if (!isPng && !isPdf && !isXml && typeof row.data === "string") {
      const fromText = coerceToArrayBuffer(row.data);
      if (fromText && fromText.byteLength > 0) buf = fromText;
    }
  }

  if (!buf || buf.byteLength === 0) return null;
  return { data: buf, contentType: row.content_type };
}
