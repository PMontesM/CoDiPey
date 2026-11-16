import type { Env } from "../types";

/** Claves que el superadmin puede sobrescribir en D1 (ganan sobre env si no están vacías). */
export const SETTINGS_KEYS = [
  "BUSINESS_NAME",
  "PUBLIC_URL",
  "PEY_API_KEY",
  "PEY_WEBHOOK_SECRET",
  "FACTURAPI_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_SANDBOX_JOIN_CODE",
  "TWILIO_SMS_FROM",
  "ADMIN_API_SECRET",
  "FILE_SIGNING_SECRET",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

const SECRET_KEYS = new Set<SettingKey>([
  "PEY_API_KEY",
  "PEY_WEBHOOK_SECRET",
  "FACTURAPI_KEY",
  "TWILIO_AUTH_TOKEN",
  "ADMIN_API_SECRET",
  "FILE_SIGNING_SECRET",
]);

export function isSettingKey(key: string): key is SettingKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isSecretSetting(key: SettingKey): boolean {
  return SECRET_KEYS.has(key);
}

/** Crea la tabla si falta (útil cuando el token de deploy no puede aplicar migraciones D1). */
export async function ensureSettingsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at)",
    ).run();
  } catch {
    /* índice opcional */
  }
}

export async function loadSettingsMap(
  env: Env,
): Promise<Partial<Record<SettingKey, string>>> {
  try {
    await ensureSettingsTable(env);
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings",
    ).all<{ key: string; value: string }>();
    const out: Partial<Record<SettingKey, string>> = {};
    for (const row of results || []) {
      if (isSettingKey(row.key) && row.value != null && String(row.value).length) {
        out[row.key] = String(row.value);
      }
    }
    return out;
  } catch (err) {
    console.log(`[settings] load failed: ${String(err)}`);
    return {};
  }
}

/**
 * Env efectivo: valores de D1 pisan secrets de Wrangler cuando existen.
 * DB y ASSETS siempre vienen del binding real.
 */
export async function withSettings(env: Env): Promise<Env> {
  const map = await loadSettingsMap(env);
  if (!Object.keys(map).length) return env;
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && isSettingKey(prop)) {
        const override = map[prop];
        if (override != null && override !== "") return override;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}

export function maskSecret(value: string | undefined | null): string {
  const v = (value || "").trim();
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return `••••${v.slice(-4)}`;
}

export type SettingRowView = {
  key: SettingKey;
  secret: boolean;
  /** Valor efectivo (enmascarado si es secreto). */
  effective: string;
  /** Hay override en D1. */
  from_db: boolean;
  /** Hay valor en env (Wrangler). */
  from_env: boolean;
  /** Placeholder para inputs (vacío = no cambiar). */
  input_placeholder: string;
};

export async function listSettingsView(env: Env): Promise<SettingRowView[]> {
  const map = await loadSettingsMap(env);
  return SETTINGS_KEYS.map((key) => {
    const envVal = String((env as Record<string, unknown>)[key] || "").trim();
    const dbVal = (map[key] || "").trim();
    const effectiveRaw = dbVal || envVal;
    const secret = isSecretSetting(key);
    return {
      key,
      secret,
      effective: secret ? maskSecret(effectiveRaw) : effectiveRaw,
      from_db: Boolean(dbVal),
      from_env: Boolean(envVal),
      input_placeholder: secret
        ? dbVal || envVal
          ? "•••• configurado — escribe uno nuevo para reemplazar"
          : "Pegar secreto"
        : effectiveRaw || "—",
    };
  });
}

export async function upsertSetting(
  env: Env,
  key: SettingKey,
  value: string,
): Promise<void> {
  await ensureSettingsTable(env);
  const ts = new Date().toISOString();
  const trimmed = value.trim();
  if (!trimmed) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, trimmed, ts)
    .run();
}

export async function upsertSettings(
  env: Env,
  patch: Partial<Record<SettingKey, string>>,
): Promise<void> {
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = patch[key];
    if (raw === undefined) continue;
    // Secretos: string vacío = no tocar; "__CLEAR__" = borrar override
    if (isSecretSetting(key)) {
      if (raw === "") continue;
      if (raw === "__CLEAR__") {
        await upsertSetting(env, key, "");
        continue;
      }
      await upsertSetting(env, key, raw);
      continue;
    }
    await upsertSetting(env, key, raw);
  }
}
