import { ensureSettingsTable } from "./settings";
import type { Env } from "../types";

const PASSWORD_KEY = "SUPERADMIN_PASSWORD";

/**
 * Contraseña del panel (D1). El SUPERADMIN_SECRET de Wrangler sigue valiendo
 * como llave de respaldo y para el primer acceso.
 */
export async function getPanelPassword(env: Env): Promise<string> {
  try {
    await ensureSettingsTable(env);
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = ?",
    )
      .bind(PASSWORD_KEY)
      .first<{ value: string }>();
    return (row?.value || "").trim();
  } catch {
    return "";
  }
}

export async function setPanelPassword(
  env: Env,
  password: string,
): Promise<void> {
  await ensureSettingsTable(env);
  const trimmed = password.trim();
  const ts = new Date().toISOString();
  if (!trimmed) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?")
      .bind(PASSWORD_KEY)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(PASSWORD_KEY, trimmed, ts)
    .run();
}

function tokenFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  const headerToken = request.headers.get("x-superadmin-token") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  return bearer || headerToken;
}

export function superadminConfigured(env: Env): boolean {
  return Boolean((env.SUPERADMIN_SECRET || "").trim());
}

/**
 * Acepta la contraseña del panel (D1) o el SUPERADMIN_SECRET de Wrangler.
 */
export async function requireSuperadmin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const wranglerSecret = (env.SUPERADMIN_SECRET || "").trim();
  const panelPassword = await getPanelPassword(env);
  if (!wranglerSecret && !panelPassword) {
    return Response.json(
      {
        detail:
          "Superadmin desactivado: define SUPERADMIN_SECRET en Wrangler (una sola vez) y vuelve a desplegar.",
        configured: false,
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
  const token = tokenFromRequest(request);
  if (
    (wranglerSecret && token === wranglerSecret) ||
    (panelPassword && token === panelPassword)
  ) {
    return null;
  }
  return Response.json(
    { detail: "No autorizado", configured: true },
    { status: 401, headers: { "cache-control": "private, no-store" } },
  );
}
