import type { Env } from "../types";
import { nowIso } from "./parse";

export async function putBlob(
  env: Env,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO blobs (key, content_type, data, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       content_type = excluded.content_type,
       data = excluded.data,
       updated_at = excluded.updated_at`,
  )
    .bind(key, contentType, data, nowIso())
    .run();
}

export async function getBlob(
  env: Env,
  key: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const row = await env.DB.prepare(
    "SELECT content_type, data FROM blobs WHERE key = ?",
  )
    .bind(key)
    .first<{ content_type: string; data: ArrayBuffer }>();
  if (!row) return null;
  return { data: row.data, contentType: row.content_type };
}
