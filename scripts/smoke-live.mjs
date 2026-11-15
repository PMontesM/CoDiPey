#!/usr/bin/env node
/**
 * Smoke live: Worker + Twilio webhook config + recent inbound errors.
 * Exit 1 if production webhook or Twilio sandbox is misconfigured.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCTION = "https://cobro-codi.inomali.workers.dev";
// Prefer explicit SMOKE_URL; ignore stale tunnel PUBLIC_URL from local .env
const WORKER = (
  process.env.SMOKE_URL ||
  PRODUCTION
).replace(/\/$/, "");
const EXPECTED_TWILIO_WEBHOOK = `${PRODUCTION}/whatsapp/webhook`;

function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log("OK:", msg);
}

async function main() {
  console.log("Smoke against", WORKER);

  const health = await fetch(`${WORKER}/health`);
  if (!health.ok) fail(`/health HTTP ${health.status}`);
  else {
    const j = await health.json();
    if (j.status !== "ok") fail(`/health body ${JSON.stringify(j)}`);
    else ok("/health");
  }

  const smokeFrom = "whatsapp:+5215500009999";
  const wa = await fetch(`${WORKER}/whatsapp/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: smokeFrom,
      Body: "1 Smoke Test 0.01",
    }),
  });
  const twiml = await wa.text();
  // Con Twilio: Content API envía botones y el webhook responde TwiML vacío.
  // Sin Twilio: el texto de factura viaja en TwiML.
  const twimlOk =
    wa.ok &&
    (twiml.includes("<Response></Response>") ||
      (twiml.includes("Orden #") && /factura/i.test(twiml)));
  if (!twimlOk) {
    fail(`whatsapp step1 unexpected: ${wa.status} ${twiml.slice(0, 200)}`);
  } else {
    const ordenes = await fetch(`${WORKER}/api/ordenes`);
    const list = ordenes.ok ? await ordenes.json() : null;
    const rows = list?.ordenes || (Array.isArray(list) ? list : []);
    const hit = rows.find(
      (o) => o.telefono === smokeFrom && o.estado_chat === "ESPERANDO_FACTURA",
    );
    if (!hit) {
      fail("whatsapp step1: no order in ESPERANDO_FACTURA for smoke phone");
    } else ok(`whatsapp step1 creates order #${hit.id} (interactive or TwiML)`);
  }

  const env = loadEnv();
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    fail("missing TWILIO creds in .env — cannot verify sandbox webhook");
    return;
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const senders = await fetch(
    "https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp",
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const sendersJson = await senders.json();
  const sender = sendersJson.senders?.[0];
  const callback = sender?.webhook?.callback_url || "";
  console.log("Twilio sender webhook:", callback || "(empty)");
  if (callback !== EXPECTED_TWILIO_WEBHOOK) {
    fail(
      `Twilio Channels/Senders webhook is "${callback}" — expected "${EXPECTED_TWILIO_WEBHOOK}"`,
    );
  } else ok("Twilio Channels/Senders webhook");

  // Most recent inbound: 11210 means Sandbox UI still points to a dead tunnel
  const msgs = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=15`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const list = await msgs.json();
  const latestInbound = (list.messages || []).find(
    (m) => m.direction === "inbound",
  );
  if (!latestInbound) {
    ok("no inbound messages to validate yet");
  } else if (String(latestInbound.error_code) === "11210") {
    fail(
      `Latest Twilio inbound has error 11210 (bad webhook host). body="${(latestInbound.body || "").slice(0, 40)}". ` +
        `Sandbox "When a message comes in" must be ${EXPECTED_TWILIO_WEBHOOK} (Channels/Senders can be correct while Sandbox UI is stale).`,
    );
  } else {
    ok(
      `latest inbound ok (status=${latestInbound.status}, err=${latestInbound.error_code || "none"})`,
    );
  }

  // fingerprint pey key presence only
  if (env.PEY_API_KEY) {
    ok(
      `PEY_API_KEY present sha12=${createHash("sha256").update(env.PEY_API_KEY).digest("hex").slice(0, 12)}`,
    );
  } else fail("PEY_API_KEY missing in .env");

  if (process.exitCode) {
    console.error("\nSmoke FAILED");
    process.exit(1);
  }
  console.log("\nSmoke PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
