import { Hono } from "hono";
import { buildOrdenesPayload, resolveEmisor } from "./lib/admin";
import { getBlob } from "./lib/blobs";
import { handleWhatsappMessage } from "./lib/chat";
import {
  runAllConnectionTests,
  runConnectionTest,
  type ConnectionTestId,
} from "./lib/connection-tests";
import { simularCobroDemo, simularPagoDemo } from "./lib/demo";
import { loadE2eReport, runE2eHealth } from "./lib/e2e-health";
import {
  buildJoinPayload,
  registrarDemoWhatsapp,
} from "./lib/demo-whatsapp";
import { evaluarYTimbrar } from "./lib/facturapi";
import { nowIso, xmlEscape } from "./lib/parse";
import { getQrExpiresInSec } from "./lib/pey";
import {
  isProtectedFileKey,
  requireOperator,
  signedFilePath,
  verifyFileAccess,
  verifyPeyWebhook,
  verifyTwilioSignature,
} from "./lib/security";
import {
  listSettingsView,
  upsertSettings,
  withSettings,
  type SettingKey,
} from "./lib/settings";
import {
  clearErrorLog,
  listErrorLog,
  logAppError,
  logCaughtError,
} from "./lib/error-log";
import {
  getPanelPassword,
  requireSuperadmin,
  setPanelPassword,
  superadminConfigured,
} from "./lib/superadmin";
import { maskOrdenForApi } from "./lib/privacy";
import { renderTicketHtmlPage } from "./lib/ticket";
import { sendWhatsapp } from "./lib/twilio";
import type { Env, Item, Orden } from "./types";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.onError(async (err, c) => {
  console.log(`[http] ${c.req.method} ${c.req.path}: ${String(err)}`);
  await logCaughtError(c.env, "http", err, `${c.req.method} ${c.req.path}`);
  return c.json({ detail: "Error interno" }, 500);
});

async function runtimeEnv(env: Env): Promise<Env> {
  return withSettings(env);
}

function publicUrlFrom(env: Env, reqUrl: string): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  return new URL(reqUrl).origin;
}

async function guardOperator(c: {
  req: { raw: Request };
  env: Env;
}): Promise<Response | null> {
  const env = await runtimeEnv(c.env);
  return requireOperator(c.req.raw, env);
}

app.get("/health", (c) => c.json({ status: "ok", runtime: "cloudflare-worker" }));

app.get("/", async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
    if (res.ok) return res;
  }
  return c.redirect("/admin");
});

app.get("/admin", async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(new URL("/admin.html", c.req.url));
    if (res.ok) return res;
  }
  return c.text("admin.html no encontrado", 404);
});

app.get("/superadmin", async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(
      new URL("/superadmin.html", c.req.url),
    );
    if (res.ok) return res;
  }
  return c.text("superadmin.html no encontrado", 404);
});

app.get("/api/superadmin/status", (c) =>
  c.json({
    configured: superadminConfigured(c.env),
    webhooks: {
      twilio: `${new URL(c.req.url).origin}/whatsapp/webhook`,
      pey: `${new URL(c.req.url).origin}/pey/webhook`,
    },
  }),
);

app.get("/api/superadmin/settings", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const base = publicUrlFrom(env, c.req.url);
  const panelPassword = await getPanelPassword(c.env);
  return c.json(
    {
      settings: await listSettingsView(c.env),
      webhooks: {
        twilio: `${base}/whatsapp/webhook`,
        pey: `${base}/pey/webhook`,
      },
      business_name: (env.BUSINESS_NAME || "Mostrito").trim() || "Mostrito",
      password_set: Boolean(panelPassword),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
});

app.put("/api/superadmin/settings", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  let body: Partial<Record<SettingKey, string>> = {};
  try {
    body = (await c.req.json()) as Partial<Record<SettingKey, string>>;
  } catch {
    return c.json({ detail: "JSON inválido" }, 400);
  }
  try {
    await upsertSettings(c.env, body);
  } catch (err) {
    return c.json(
      {
        detail: `No se pudo guardar: ${String(err)}`,
      },
      500,
    );
  }
  const env = await runtimeEnv(c.env);
  return c.json({
    ok: true,
    settings: await listSettingsView(c.env),
    business_name: (env.BUSINESS_NAME || "Mostrito").trim() || "Mostrito",
    password_set: Boolean(await getPanelPassword(c.env)),
  });
});

/** Contraseña del panel (editable aquí; el secret de Wrangler queda de respaldo). */
app.put("/api/superadmin/password", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  let password = "";
  try {
    const body = (await c.req.json()) as { password?: string };
    password = String(body.password || "");
  } catch {
    return c.json({ detail: "JSON inválido" }, 400);
  }
  const trimmed = password.trim();
  if (trimmed.length < 6) {
    return c.json(
      { detail: "La contraseña debe tener al menos 6 caracteres." },
      400,
    );
  }
  await setPanelPassword(c.env, trimmed);
  return c.json({
    ok: true,
    password_set: true,
    detail: "Contraseña actualizada. Úsala la próxima vez para entrar.",
  });
});

app.post("/api/superadmin/test/:id", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const id = String(c.req.param("id") || "") as ConnectionTestId;
  if (id !== "pey" && id !== "facturapi" && id !== "twilio") {
    return c.json({ detail: "id inválido" }, 400);
  }
  const env = await runtimeEnv(c.env);
  const result = await runConnectionTest(env, id);
  return c.json(result, result.ok ? 200 : 502);
});

app.post("/api/superadmin/test", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const results = await runAllConnectionTests(env);
  return c.json({ results });
});

/** Último reporte E2E guardado en D1. */
app.get("/api/superadmin/e2e", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const last = await loadE2eReport(c.env);
  return c.json(
    { last },
    { headers: { "cache-control": "private, no-store" } },
  );
});

/**
 * Prueba E2E completa: config, D1, APIs, cobro demo, pago, ticket.
 * Crea una orden demo real (~$25) como el botón del panel.
 */
app.post("/api/superadmin/e2e", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const report = await runE2eHealth(env, publicUrlFrom(env, c.req.url));
  return c.json(report, report.ok ? 200 : 502);
});

app.get("/api/superadmin/errors", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const limit = Number(c.req.query("limit") || 50);
  const errors = await listErrorLog(c.env, limit);
  return c.json(
    { errors },
    { headers: { "cache-control": "private, no-store" } },
  );
});

app.delete("/api/superadmin/errors", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  const cleared = await clearErrorLog(c.env);
  return c.json({ ok: true, cleared });
});

/** Solo para comprobar que el log funciona desde el panel. */
app.post("/api/superadmin/errors/sample", async (c) => {
  const denied = await requireSuperadmin(c.req.raw, c.env);
  if (denied) return denied;
  await logAppError(c.env, {
    level: "warn",
    source: "superadmin",
    message: "Prueba manual de log desde el panel",
    context: "/api/superadmin/errors/sample",
  });
  return c.json({ ok: true });
});

app.get("/files/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[\w.-]+$/.test(key)) return c.text("invalid", 400);
  const env = await runtimeEnv(c.env);
  if (isProtectedFileKey(key)) {
    const ok = await verifyFileAccess(
      env,
      key,
      c.req.query("exp") || null,
      c.req.query("sig") || null,
    );
    if (!ok) return c.text("forbidden", 403);
  }
  const obj = await getBlob(c.env, key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.data, {
    headers: {
      "content-type": obj.contentType,
      "cache-control": isProtectedFileKey(key)
        ? "private, no-store"
        : "public, max-age=300",
    },
  });
});

/** Ticket HTML responsive (WhatsApp no embebe HTML; se abre en el navegador). */
app.get("/ticket/:id", async (c) => {
  const env = await runtimeEnv(c.env);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.text("Orden inválida", 400);
  const orden = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(id)
    .first<Orden>();
  if (!orden) return c.text("Orden no encontrada", 404);

  let items: Item[] = [];
  try {
    const raw = JSON.parse(orden.conceptos) as Item[];
    if (Array.isArray(raw)) items = raw;
  } catch {
    items = [];
  }

  const expires = await getQrExpiresInSec(env, {
    id: orden.id,
    pago_estado: orden.pago_estado,
    pey_qr_id: orden.pey_qr_id,
  });
  let estado: "PENDIENTE" | "PAGADO" | "CANCELADO" | "VENCIDO" = "PENDIENTE";
  if (orden.pago_estado === "PAGADO") estado = "PAGADO";
  else if (
    orden.pago_estado === "CANCELADO" ||
    orden.estado_chat === "CANCELADO"
  ) {
    estado = "CANCELADO";
  } else if (orden.pey_qr_id && expires === 0) {
    estado = "VENCIDO";
  }

  const base = publicUrlFrom(env, c.req.url);
  const rawQr = await getBlob(c.env, `qr_code_${orden.id}.png`);
  const qrImageUrl = rawQr
    ? `${base}/files/qr_code_${orden.id}.png`
    : `${base}/files/qr_${orden.id}.png`;
  const businessName =
    (env.BUSINESS_NAME || "Mostrito").trim() || "Mostrito";
  const html = renderTicketHtmlPage({
    meta: {
      ordenId: orden.id,
      monto: String(orden.monto),
      items,
      concepto: orden.concepto_pey || undefined,
      peyQrId: orden.pey_qr_id,
      vigenciaMin: 10,
      businessName,
    },
    qrImageUrl,
    estado,
    expiresInSec: expires,
    paymentUrl: orden.pey_payment_url ?? null,
  });
  return c.html(html, 200, {
    "cache-control": "public, max-age=30",
  });
});

app.get("/api/ordenes", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT o.*,
            c.rfc AS rfc,
            c.razon_social AS razon_social,
            c.codigo_postal AS codigo_postal,
            c.regimen AS regimen,
            c.uso_cfdi AS uso_cfdi
     FROM ordenes o
     LEFT JOIN clientes_fiscales c ON c.id = o.cliente_fiscal_id
     ORDER BY o.id DESC`,
  ).all<Orden & Record<string, unknown>>();
  const rows = results || [];
  const withExpiry = await Promise.all(
    rows.map(async (o) => {
      const expires_in_sec = await getQrExpiresInSec(env, {
        id: Number(o.id),
        pago_estado: String(o.pago_estado),
        pey_qr_id: (o.pey_qr_id as string | null) || null,
      });
      return {
        ...o,
        expires_in_sec,
        qr_vencido:
          expires_in_sec === 0 &&
          o.pago_estado === "PENDIENTE" &&
          !!o.pey_qr_id,
      };
    }),
  );
  const emisor = await resolveEmisor(env);
  const payload = buildOrdenesPayload(withExpiry, emisor);
  const base = publicUrlFrom(env, c.req.url);
  payload.ordenes = await Promise.all(
    payload.ordenes.map(async (o) => {
      if (!o.facturapi_id) return o;
      const id = Number(o.id);
      return {
        ...o,
        factura_pdf_url: await signedFilePath(
          env,
          base,
          `factura_${id}.pdf`,
        ),
        factura_xml_url: await signedFilePath(
          env,
          base,
          `factura_${id}.xml`,
        ),
      };
    }),
  );
  return c.json(payload, {
    headers: { "cache-control": "private, no-store" },
  });
});

/** Redirección a PDF/XML firmado (evita /files/factura sin firma en el demo). */
app.get("/api/ordenes/:id/factura.:ext", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const ext = String(c.req.param("ext") || "").toLowerCase();
  if (!Number.isFinite(id) || id <= 0 || (ext !== "pdf" && ext !== "xml")) {
    return c.text("invalid", 400);
  }
  const row = await c.env.DB.prepare(
    "SELECT id, facturapi_id FROM ordenes WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; facturapi_id: string | null }>();
  if (!row) return c.text("not found", 404);
  if (!row.facturapi_id) return c.text("sin factura", 404);
  const key = `factura_${id}.${ext}`;
  const env = await runtimeEnv(c.env);
  const blob = await getBlob(c.env, key);
  if (!blob) return c.text("not found", 404);
  const target = await signedFilePath(env, publicUrlFrom(env, c.req.url), key);
  return c.redirect(target, 302);
});

app.post("/api/ordenes/:id/reintentar-timbrado", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(id)
    .first<Orden>();
  if (!row) return c.json({ detail: "Orden no encontrada" }, 404);
  if (row.facturapi_id) {
    return c.json({ orden: maskOrdenForApi(row), message: "Ya timbrada" });
  }
  const updated = await evaluarYTimbrar(env, publicUrlFrom(env, c.req.url), id);
  if (!updated) return c.json({ detail: "Orden no encontrada" }, 404);
  return c.json({ orden: maskOrdenForApi(updated) });
});

app.post("/api/ordenes/:id/cancelar", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(id)
    .first<Orden>();
  if (!row) return c.json({ detail: "Orden no encontrada" }, 404);
  if (row.pago_estado === "PAGADO") {
    return c.json(
      { detail: "No se puede cancelar: ya está pagada." },
      409,
    );
  }
  if (row.estado_chat === "CANCELADO" || row.pago_estado === "CANCELADO") {
    return c.json({
      orden: maskOrdenForApi(row),
      message: "Ya estaba cancelada",
    });
  }
  await c.env.DB.prepare(
    `UPDATE ordenes
     SET estado_chat = 'CANCELADO', pago_estado = 'CANCELADO', updated_at = ?
     WHERE id = ?`,
  )
    .bind(nowIso(), id)
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(id)
    .first<Orden>();
  return c.json({
    orden: updated ? maskOrdenForApi(updated) : updated,
    message: "Orden cancelada",
  });
});

/** Config pública para unirse al WhatsApp de Mostrito (Sandbox Twilio). */
app.get("/api/demo/whatsapp-join", async (c) => {
  const env = await runtimeEnv(c.env);
  const payload = buildJoinPayload(env);
  return c.json({
    configured: payload.configured,
    sandbox: payload.sandbox,
    join_text: payload.configured ? payload.join_text : null,
    wa_link: payload.configured ? payload.wa_link : null,
    sms_disponible: Boolean((env.TWILIO_SMS_FROM || "").trim()),
    nota: payload.configured
      ? "Pon tu número, abre WhatsApp con el mensaje listo y escribe hola."
      : "Falta TWILIO_SANDBOX_JOIN_CODE en el Worker o en Superadmin.",
  });
});

/** Registro público de WhatsApp: guarda el número y devuelve wa.me con join. */
app.post("/api/demo/registrar-whatsapp", async (c) => {
  const env = await runtimeEnv(c.env);
  let telefono = "";
  try {
    const body = (await c.req.json()) as { telefono?: string };
    telefono = String(body.telefono || "");
  } catch {
    return c.json({ detail: "JSON inválido" }, 400);
  }
  const result = await registrarDemoWhatsapp(env, telefono);
  return c.json(result.body, result.status as 200 | 400 | 503);
});

/** Demo: crea cobro + QR (requiere operador). */
app.post("/api/demo/simular-cobro", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  try {
    const result = await simularCobroDemo(env, publicUrlFrom(env, c.req.url));
    return c.json(result);
  } catch (err) {
    await logCaughtError(env, "demo.simular-cobro", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ detail: msg }, 502);
  }
});

/** Demo: liquida como pey webhook + timbra CFDI (requiere operador). */
app.post("/api/demo/simular-pago/:id", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const env = await runtimeEnv(c.env);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ detail: "id inválido" }, 400);
  }
  try {
    const result = await simularPagoDemo(env, publicUrlFrom(env, c.req.url), id);
    return c.json(result);
  } catch (err) {
    await logCaughtError(env, "demo.simular-pago", err, `orden #${id}`);
    const status = (err as Error & { status?: number }).status || 500;
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ detail: msg }, status as 400 | 404 | 409 | 500);
  }
});

app.post("/whatsapp/webhook", async (c) => {
  const env = await runtimeEnv(c.env);
  const form = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") params[k] = v;
  }
  const signed = await verifyTwilioSignature(env, c.req.raw, params);
  if (!signed) {
    return c.text("Forbidden", 403);
  }
  const body = String(form.Body || "");
  const from = String(form.From || "whatsapp:+0000000000");
  const buttonPayload = String(
    form.ButtonPayload || form.ListId || form.InteractiveData || "",
  );
  const buttonText = String(form.ButtonText || "");
  let reply: string;
  try {
    reply = await handleWhatsappMessage(
      env,
      publicUrlFrom(env, c.req.url),
      from,
      body,
      buttonPayload || undefined,
      buttonText || undefined,
    );
  } catch (err) {
    console.log(`[whatsapp] unhandled: ${String(err)}`);
    await logCaughtError(env, "whatsapp", err, from);
    reply =
      "Ocurrió un error temporal. Reintenta en unos segundos o contacta al comercio.";
    try {
      await sendWhatsapp(env, from, reply);
    } catch {
      /* ignore */
    }
  }
  const twiml = reply.trim()
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return c.body(twiml, 200, { "Content-Type": "application/xml" });
});

app.post("/pey/webhook", async (c) => {
  const env = await runtimeEnv(c.env);
  const rawBody = await c.req.text();
  const okSig = await verifyPeyWebhook(env, c.req.raw, rawBody);
  if (!okSig) {
    const hasSecret = Boolean((env.PEY_WEBHOOK_SECRET || "").trim());
    await logAppError(env, {
      level: "error",
      source: "pey.webhook",
      message: hasSecret
        ? "Webhook pey rechazado: firma inválida"
        : "Webhook pey rechazado: falta PEY_WEBHOOK_SECRET",
      detail: hasSecret
        ? "Revisa el secreto en pey vs Superadmin/Wrangler."
        : "Configura PEY_WEBHOOK_SECRET en /superadmin (o wrangler secret put).",
      context: "/pey/webhook",
    });
    return c.json({ detail: "invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await logAppError(env, {
      level: "warn",
      source: "pey.webhook",
      message: "Webhook pey con JSON inválido",
      context: "/pey/webhook",
    });
    return c.json({ ok: true, ignored: "invalid json" });
  }
  const event = String(
    payload.event || payload.type || payload.eventType || "",
  );
  const data = (payload.data || payload.payload || payload) as Record<
    string,
    unknown
  >;

  if (event === "payment_link.status_updated") {
    const status = String(payload.status || data.status || "");
    if (status !== "paid") {
      return c.json({
        ok: true,
        ignored: `payment_link ${status || "no-status"}`,
      });
    }
    const txs = (payload.transactions || data.transactions || []) as Array<
      Record<string, unknown>
    >;
    const txId =
      txs[0]?.transactionId ||
      txs[0]?.transaction_id ||
      payload.transactionId ||
      data.transactionId;
    const clientRef = String(
      payload.clientReferenceId ||
        data.clientReferenceId ||
        payload.client_reference_id ||
        data.client_reference_id ||
        "",
    );
    if (!txId) {
      return c.json({ ok: true, ignored: "payment_link sin transactionId" });
    }

    const existing = await c.env.DB.prepare(
      "SELECT id FROM ordenes WHERE pey_transaction_id = ?",
    )
      .bind(String(txId))
      .first<{ id: number }>();
    if (existing) {
      return c.json({ ok: true, duplicate: true, orden_id: existing.id });
    }

    let orden: Orden | null = null;
    if (/^\d+$/.test(clientRef)) {
      orden = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
        .bind(Number(clientRef))
        .first<Orden>();
    }
    if (!orden) {
      await logAppError(env, {
        level: "warn",
        source: "pey.webhook",
        message: "payment_link pagado sin orden local",
        detail: `clientReferenceId=${clientRef || "—"} tx=${String(txId)}`,
        context: "/pey/webhook",
      });
      return c.json({ ok: true, ignored: "unknown clientReferenceId" });
    }

    const nextEstado =
      Number(orden.requiere_factura) === 1 ? orden.estado_chat : "COMPLETADO";
    await c.env.DB.prepare(
      `UPDATE ordenes SET pago_estado = 'PAGADO', pey_transaction_id = ?, estado_chat = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(String(txId), nextEstado, nowIso(), orden.id)
      .run();

    await sendWhatsapp(
      env,
      orden.telefono,
      `💰 Pago confirmado: $${orden.monto} MXN (orden #${orden.id}).`,
    );
    await evaluarYTimbrar(env, publicUrlFrom(env, c.req.url), orden.id);
    return c.json({
      ok: true,
      orden_id: orden.id,
      pago: "PAGADO",
      via: "payment_link",
    });
  }

  if (
    event &&
    !["codi.qr.payment_received", "codi.pn.payment_received"].includes(event)
  ) {
    if (!data.transactionId && !data.transaction_id) {
      return c.json({ ok: true, ignored: `event ${event}` });
    }
  }

  const txId =
    data.transactionId || data.transaction_id || payload.transactionId;
  const numRef =
    data.numRef || data.num_ref || data.reference || payload.numRef;
  if (!txId) {
    await logAppError(env, {
      level: "warn",
      source: "pey.webhook",
      message: "Webhook pey sin transactionId",
      detail: `event=${event || "—"}`,
      context: "/pey/webhook",
    });
    return c.json({ ok: true, ignored: "no transactionId" });
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM ordenes WHERE pey_transaction_id = ?",
  )
    .bind(String(txId))
    .first<{ id: number }>();
  if (existing) {
    return c.json({ ok: true, duplicate: true, orden_id: existing.id });
  }

  let orden: Orden | null = null;
  if (numRef != null && /^\d+$/.test(String(numRef))) {
    orden = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
      .bind(Number(numRef))
      .first<Orden>();
  }
  if (!orden) {
    await logAppError(env, {
      level: "warn",
      source: "pey.webhook",
      message: "Pago pey sin orden local (numRef)",
      detail: `numRef=${String(numRef ?? "—")} tx=${String(txId)} event=${event || "—"}`,
      context: "/pey/webhook",
    });
    return c.json({ ok: true, ignored: "unknown numRef" });
  }

  const nextEstado =
    Number(orden.requiere_factura) === 1 ? orden.estado_chat : "COMPLETADO";
  await c.env.DB.prepare(
    `UPDATE ordenes SET pago_estado = 'PAGADO', pey_transaction_id = ?, estado_chat = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(String(txId), nextEstado, nowIso(), orden.id)
    .run();

  await sendWhatsapp(
    env,
    orden.telefono,
    `💰 Pago confirmado: $${orden.monto} MXN (orden #${orden.id}).`,
  );
  await evaluarYTimbrar(env, publicUrlFrom(env, c.req.url), orden.id);
  return c.json({ ok: true, orden_id: orden.id, pago: "PAGADO" });
});

/** Estáticos de /public (p. ej. hero-barrio.jpg) vía binding ASSETS. */
app.get("*", async (c) => {
  if (!c.env.ASSETS) return c.text("not found", 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) return c.text("not found", 404);
  return res;
});

export default app;
