import type { Env } from "../types";

export async function sendWhatsapp(
  env: Env,
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.log(`[whatsapp mock] to=${to} body=${body} media=${mediaUrl}`);
    return;
  }
  const dest = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const form = new URLSearchParams();
  form.set("From", env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886");
  form.set("To", dest);
  form.set("Body", body);
  if (mediaUrl) form.set("MediaUrl", mediaUrl);

  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    if (!res.ok) {
      console.log(`[whatsapp] send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.log(`[whatsapp] send failed: ${String(err)}`);
  }
}
