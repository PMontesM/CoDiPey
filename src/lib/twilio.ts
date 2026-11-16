import type { Env } from "../types";
import { logAppError } from "./error-log";

export type QuickReplyAction = { title: string; id: string };
export type ListItem = { id: string; item: string; description?: string };

function authHeader(env: Env): string {
  return `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
}

function hasTwilio(env: Env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
}

export async function sendWhatsapp(
  env: Env,
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<void> {
  if (!hasTwilio(env)) {
    console.log(`[whatsapp mock] to=${to} body=${body} media=${mediaUrl}`);
    return;
  }
  const dest = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const form = new URLSearchParams();
  form.set("From", env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886");
  form.set("To", dest);
  form.set("Body", body);
  if (mediaUrl) form.set("MediaUrl", mediaUrl);

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
      const bodyText = await res.text();
      console.log(`[whatsapp] send failed: ${res.status} ${bodyText}`);
      await logAppError(env, {
        source: "twilio",
        message: `WhatsApp send HTTP ${res.status}`,
        detail: bodyText,
        context: dest,
      });
    }
  } catch (err) {
    console.log(`[whatsapp] send failed: ${String(err)}`);
    await logAppError(env, {
      source: "twilio",
      message: err instanceof Error ? err.message : String(err),
      detail: String(err),
      context: dest,
    });
  }
}

async function createContent(
  env: Env,
  friendlyName: string,
  types: Record<string, unknown>,
): Promise<string | null> {
  const res = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      friendly_name: friendlyName.slice(0, 60),
      language: "es",
      types,
    }),
  });
  if (!res.ok) {
    console.log(`[whatsapp] content create failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = (await res.json()) as { sid?: string };
  return data.sid || null;
}

async function sendContent(
  env: Env,
  to: string,
  contentSid: string,
): Promise<boolean> {
  const dest = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const form = new URLSearchParams();
  form.set("From", env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886");
  form.set("To", dest);
  form.set("ContentSid", contentSid);
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
    console.log(`[whatsapp] content send failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

/**
 * WhatsApp solo muestra 3 botones y no hay menú “pegajoso” en Sandbox.
 * Por defecto reservamos el 3er slot para *Menú*.
 * Con `stickyMenu: false` se respetan hasta 3 acciones tal cual (p. ej. Sí esos / Otros / Sin RFC).
 */
export function ensureMenuActions(
  actions: QuickReplyAction[],
  stickyMenu = true,
): QuickReplyAction[] {
  if (!stickyMenu) {
    return actions.slice(0, 3);
  }
  const primary = actions
    .filter((a) => a.id !== "MENU" && a.id !== "HELP")
    .slice(0, 2);
  return [...primary, { title: "Menú", id: "MENU" }];
}

export type QuickReplyOpts = {
  /** Default true. false = no forzar Menú; útil cuando los 3 botones son del flujo. */
  stickyMenu?: boolean;
};

/** Envía botones de respuesta rápida (tarjeta interactiva WhatsApp). */
export async function sendWhatsappQuickReply(
  env: Env,
  to: string,
  body: string,
  actions: QuickReplyAction[],
  opts?: QuickReplyOpts,
): Promise<boolean> {
  const finalActions = ensureMenuActions(actions, opts?.stickyMenu !== false);
  if (!hasTwilio(env)) {
    console.log(
      `[whatsapp mock] quick-reply to=${to} body=${body} actions=${JSON.stringify(finalActions)}`,
    );
    return false;
  }
  const sid = await createContent(env, `qr_${Date.now()}`, {
    "twilio/quick-reply": {
      body: body.slice(0, 1024),
      actions: finalActions.map((a) => ({
        title: a.title.slice(0, 20),
        id: a.id.slice(0, 200),
      })),
    },
  });
  const fallback = `${body}\n\n${finalActions.map((a, i) => `${i + 1}) ${a.title}`).join("\n")}`;
  if (!sid) {
    await sendWhatsapp(env, to, fallback);
    // Ya se entregó por API: el webhook no debe repetir en TwiML
    return true;
  }
  const ok = await sendContent(env, to, sid);
  if (!ok) {
    await sendWhatsapp(env, to, fallback);
    return true;
  }
  return true;
}

/** Envía menú tipo lista (hasta 10 opciones). */
export async function sendWhatsappList(
  env: Env,
  to: string,
  body: string,
  button: string,
  items: ListItem[],
): Promise<boolean> {
  if (!hasTwilio(env)) {
    console.log(`[whatsapp mock] list to=${to} body=${body} items=${JSON.stringify(items)}`);
    return false;
  }
  const sid = await createContent(env, `list_${Date.now()}`, {
    "twilio/list-picker": {
      body: body.slice(0, 1024),
      button: button.slice(0, 20),
      items: items.slice(0, 10).map((it) => ({
        id: it.id.slice(0, 200),
        item: it.item.slice(0, 24),
        description: (it.description || "").slice(0, 72),
      })),
    },
  });
  const fallback = `${body}\n\n${items.map((it, i) => `${i + 1}) ${it.item}`).join("\n")}`;
  if (!sid) {
    await sendWhatsapp(env, to, fallback);
    return true;
  }
  const ok = await sendContent(env, to, sid);
  if (!ok) {
    await sendWhatsapp(env, to, fallback);
    return true;
  }
  return true;
}

/** Normaliza el tap de botón/lista de Twilio a un id estable. */
export function resolveInteractiveId(
  body: string,
  buttonPayload?: string,
  buttonText?: string,
): string {
  const payload = (buttonPayload || "").trim();
  if (payload) return payload;
  const text = (buttonText || body || "").trim();
  const map: Record<string, string> = {
    "sí, factura": "FACTURA_SI",
    "si, factura": "FACTURA_SI",
    "sí factura": "FACTURA_SI",
    "si factura": "FACTURA_SI",
    "solo pagar": "FACTURA_NO",
    "no factura": "FACTURA_NO",
    // No mapear "público en general" por texto: es razón social habitual en el wizard
    "sin rfc": "FISCAL_DEMO",
    "mejor sin rfc": "FISCAL_DEMO",
    "demo sat": "FISCAL_DEMO",
    "capturar datos": "FISCAL_EDIT",
    capturar: "FISCAL_EDIT",
    "cambiar datos": "FISCAL_EDIT",
    "sí tengo rfc": "FISCAL_EDIT",
    "si tengo rfc": "FISCAL_EDIT",
    "tengo rfc": "FISCAL_EDIT",
    "otros datos": "FISCAL_EDIT",
    otros: "FISCAL_EDIT",
    confirmar: "FISCAL_KEEP",
    "sí, esos": "FISCAL_KEEP",
    "si, esos": "FISCAL_KEEP",
    ok: "FISCAL_KEEP",
    "reenviar qr": "QR_RESEND",
    qr: "QR_RESEND",
    "nuevo qr": "QR_RENEW",
    "renovar qr": "QR_RENEW",
    renovar: "QR_RENEW",
    cancelar: "CANCEL",
    "cancelar cobro": "CANCEL",
    anular: "CANCEL",
    "estado del cobro": "STATUS",
    estado: "STATUS",
    status: "STATUS",
    historial: "HISTORY",
    menú: "MENU",
    menu: "MENU",
    hola: "MENU",
    hi: "MENU",
    inicio: "MENU",
    ayuda: "HELP",
    help: "HELP",
    cobrar: "CART_PAY",
    listo: "CART_PAY",
    "cobrar ya": "CART_PAY",
    "ir a cobrar": "CART_PAY",
    "agregar más": "CART_ADD",
    "agregar mas": "CART_ADD",
    agregar: "CART_ADD",
    "más productos": "CART_ADD",
    "mas productos": "CART_ADD",
    "otro producto": "CART_ADD",
  };
  const key = text.toLowerCase();
  if (map[key]) return map[key];
  // list item ids come as Body when selected in some Twilio versions
  if (
    /^PROD_/.test(text) ||
    /^FACTURA_/.test(text) ||
    /^FISCAL_/.test(text) ||
    /^REG_/.test(text) ||
    /^USO_/.test(text) ||
    /^(STATUS|HISTORY|QR_RENEW|QR_RESEND|CANCEL|MENU|HELP|CART_PAY|CART_ADD)$/.test(
      text,
    )
  ) {
    return text;
  }
  return text;
}
