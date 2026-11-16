import type { Env } from "../types";
import { nowIso } from "./parse";

const DEFAULT_SANDBOX = "+14155238886";

export function sandboxNumber(env: Env): string {
  const from = (env.TWILIO_WHATSAPP_FROM || "").replace(/^whatsapp:/i, "").trim();
  return from || DEFAULT_SANDBOX;
}

export function joinCode(env: Env): string {
  return (env.TWILIO_SANDBOX_JOIN_CODE || "").trim();
}

/** Normaliza MX / E.164. Acepta 10 dígitos, 52…, +52…, whatsapp:… */
export function normalizeMxWhatsapp(raw: string): string | null {
  let s = raw.trim().replace(/^whatsapp:/i, "").replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) {
    if (/^52\d{10}$/.test(s)) s = `+${s}`;
    else if (/^\d{10}$/.test(s)) s = `+52${s}`;
    else if (/^\d{11,15}$/.test(s)) s = `+${s}`;
    else return null;
  }
  if (!/^\+[1-9]\d{9,14}$/.test(s)) return null;
  return s;
}

export function buildJoinPayload(env: Env): {
  configured: boolean;
  sandbox: string;
  join_text: string;
  wa_link: string;
} {
  const sandbox = sandboxNumber(env);
  const code = joinCode(env);
  const join_text = code ? `join ${code}` : "";
  const digits = sandbox.replace(/\D/g, "");
  const wa_link = join_text
    ? `https://wa.me/${digits}?text=${encodeURIComponent(join_text)}`
    : "";
  return {
    configured: Boolean(code),
    sandbox,
    join_text,
    wa_link,
  };
}

function authHeader(env: Env): string {
  return `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
}

/** SMS de instrucción (no WhatsApp: el Sandbox no permite WA antes del join). */
export async function sendJoinSms(
  env: Env,
  e164: string,
  joinText: string,
  sandbox: string,
  waLink: string,
): Promise<{ sent: boolean; error?: string }> {
  const from = (env.TWILIO_SMS_FROM || "").trim();
  if (!from) {
    return { sent: false, error: "sms_no_configurado" };
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return { sent: false, error: "twilio_missing" };
  }
  const body =
    `Mostrito: abre WhatsApp y envía este mensaje a ${sandbox}:\n\n` +
    `${joinText}\n\n` +
    `O toca: ${waLink}\n` +
    `Cuando te confirmen, escribe: hola`;
  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", e164);
  form.set("Body", body);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader(env),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 240);
      return { sent: false, error: `twilio_${res.status}: ${text}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

export async function registrarDemoWhatsapp(
  env: Env,
  telefonoRaw: string,
): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const payload = buildJoinPayload(env);
  if (!payload.configured) {
    return {
      ok: false,
      status: 503,
      body: {
        detail:
          "Falta configurar TWILIO_SANDBOX_JOIN_CODE. Mientras tanto usa el panel /admin.",
      },
    };
  }
  const e164 = normalizeMxWhatsapp(telefonoRaw);
  if (!e164) {
    return {
      ok: false,
      status: 400,
      body: {
        detail: "Número inválido. Usa 10 dígitos de México (ej. 5512345678).",
      },
    };
  }

  const sms = await sendJoinSms(
    env,
    e164,
    payload.join_text,
    payload.sandbox,
    payload.wa_link,
  );

  await env.DB.prepare(
    `INSERT INTO demo_whatsapp (telefono, e164, created_at, sms_enviado, sms_error)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      telefonoRaw.trim(),
      e164,
      nowIso(),
      sms.sent ? 1 : 0,
      sms.error || null,
    )
    .run();

  return {
    ok: true,
    status: 200,
    body: {
      e164,
      sandbox: payload.sandbox,
      join_text: payload.join_text,
      wa_link: payload.wa_link,
      sms_enviado: sms.sent,
      sms_nota: sms.sent
        ? "Te mandamos un SMS con la instrucción."
        : "No hay SMS configurado (o falló). Usa el botón de WhatsApp.",
      siguiente:
        "1) Toca Abrir WhatsApp y envía el join. 2) Cuando confirme, escribe: hola",
    },
  };
}
