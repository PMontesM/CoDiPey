import type { Env } from "../types";
import { maskPhonesInText } from "./privacy";

const MAX_ROWS = 200;
const DETAIL_MAX = 2000;

export type ErrorLevel = "error" | "warn";

export type ErrorLogInput = {
  level?: ErrorLevel;
  source: string;
  message: string;
  detail?: string | null;
  context?: string | null;
};

export type ErrorLogRow = {
  id: number;
  created_at: string;
  level: string;
  source: string;
  message: string;
  detail: string | null;
  context: string | null;
};

export async function ensureErrorLogTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'error',
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      context TEXT
    )`,
  ).run();
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at DESC)",
    ).run();
  } catch {
    /* opcional */
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Registra un error/aviso. Nunca lanza (no rompe el flujo principal). */
export async function logAppError(
  env: Env,
  input: ErrorLogInput,
): Promise<void> {
  try {
    await ensureErrorLogTable(env);
    const ts = new Date().toISOString();
    const level = input.level === "warn" ? "warn" : "error";
    const message = truncate(
      maskPhonesInText((input.message || "error").trim() || "error"),
      500,
    );
    const detail = input.detail
      ? truncate(maskPhonesInText(String(input.detail)), DETAIL_MAX)
      : null;
    const context = input.context
      ? truncate(maskPhonesInText(String(input.context)), 500)
      : null;
    await env.DB.prepare(
      `INSERT INTO error_log (created_at, level, source, message, detail, context)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(ts, level, truncate(input.source, 80), message, detail, context)
      .run();

    // Mantener solo los últimos MAX_ROWS
    await env.DB.prepare(
      `DELETE FROM error_log
       WHERE id NOT IN (
         SELECT id FROM error_log ORDER BY id DESC LIMIT ?
       )`,
    )
      .bind(MAX_ROWS)
      .run();
  } catch (err) {
    console.log(`[error-log] write failed: ${String(err)}`);
  }
}

export async function logCaughtError(
  env: Env,
  source: string,
  err: unknown,
  context?: string,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof Error && err.stack ? err.stack : String(err);
  await logAppError(env, { source, message, detail, context });
}

export async function listErrorLog(
  env: Env,
  limit = 50,
): Promise<ErrorLogRow[]> {
  await ensureErrorLogTable(env);
  const n = Math.min(Math.max(1, limit), 100);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, level, source, message, detail, context
     FROM error_log
     ORDER BY id DESC
     LIMIT ?`,
  )
    .bind(n)
    .all<ErrorLogRow>();
  return results || [];
}

export async function clearErrorLog(env: Env): Promise<number> {
  await ensureErrorLogTable(env);
  const before = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM error_log",
  ).first<{ n: number }>();
  await env.DB.prepare("DELETE FROM error_log").run();
  return Number(before?.n || 0);
}
