import { Hono } from "hono";
import { buildOrdenesPayload, resolveEmisor } from "./lib/admin";
import { getBlob } from "./lib/blobs";
import { handleWhatsappMessage } from "./lib/chat";
import { simularCobroDemo, simularPagoDemo } from "./lib/demo";
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
  verifyFileAccess,
  verifyPeyWebhook,
  verifyTwilioSignature,
} from "./lib/security";
import { renderTicketHtmlPage } from "./lib/ticket";
import { sendWhatsapp } from "./lib/twilio";
import type { Env, Item, Orden } from "./types";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

function publicUrl(c: { env: Env; req: { url: string } }): string {
  if (c.env.PUBLIC_URL) return c.env.PUBLIC_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

async function guardOperator(c: {
  req: { raw: Request };
  env: Env;
}): Promise<Response | null> {
  return requireOperator(c.req.raw, c.env);
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

app.get("/files/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[\w.-]+$/.test(key)) return c.text("invalid", 400);
  if (isProtectedFileKey(key)) {
    const ok = await verifyFileAccess(
      c.env,
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

  const expires = await getQrExpiresInSec(c.env, {
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

  const base = publicUrl(c);
  const rawQr = await getBlob(c.env, `qr_code_${orden.id}.png`);
  const qrImageUrl = rawQr
    ? `${base}/files/qr_code_${orden.id}.png`
    : `${base}/files/qr_${orden.id}.png`;
  const html = renderTicketHtmlPage({
    meta: {
      ordenId: orden.id,
      monto: String(orden.monto),
      items,
      concepto: orden.concepto_pey || undefined,
      peyQrId: orden.pey_qr_id,
      vigenciaMin: 10,
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
      const expires_in_sec = await getQrExpiresInSec(c.env, {
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
  const emisor = await resolveEmisor(c.env);
  return c.json(buildOrdenesPayload(withExpiry, emisor), {
    headers: { "cache-control": "private, no-store" },
  });
});

app.post("/api/ordenes/:id/reintentar-timbrado", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(id)
    .first<Orden>();
  if (!row) return c.json({ detail: "Orden no encontrada" }, 404);
  if (row.facturapi_id) return c.json({ orden: row, message: "Ya timbrada" });
  const updated = await evaluarYTimbrar(c.env, publicUrl(c), id);
  if (!updated) return c.json({ detail: "Orden no encontrada" }, 404);
  return c.json({ orden: updated });
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
    return c.json({ orden: row, message: "Ya estaba cancelada" });
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
  return c.json({ orden: updated, message: "Orden cancelada" });
});

/** Config pública para que el juez abra WhatsApp con el join listo. */
app.get("/api/demo/whatsapp-join", (c) => {
  const payload = buildJoinPayload(c.env);
  return c.json({
    configured: payload.configured,
    sandbox: payload.sandbox,
    join_text: payload.configured ? payload.join_text : null,
    wa_link: payload.configured ? payload.wa_link : null,
    sms_disponible: Boolean((c.env.TWILIO_SMS_FROM || "").trim()),
    nota: payload.configured
      ? "Registra tu número y abre WhatsApp con el join listo. Tú no necesitas aprobación manual."
      : "Falta TWILIO_SANDBOX_JOIN_CODE en el Worker. Usa /admin para demostrar sin WhatsApp.",
  });
});

/** Registra número de juez; opcionalmente SMS; siempre devuelve wa.me con join. */
app.post("/api/demo/registrar-whatsapp", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  let telefono = "";
  try {
    const body = (await c.req.json()) as { telefono?: string };
    telefono = String(body.telefono || "");
  } catch {
    return c.json({ detail: "JSON inválido" }, 400);
  }
  const result = await registrarDemoWhatsapp(c.env, telefono);
  return c.json(result.body, result.status as 200 | 400 | 503);
});

/** Demo: crea cobro + QR CoDi (requiere operador). */
app.post("/api/demo/simular-cobro", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  try {
    const result = await simularCobroDemo(c.env, publicUrl(c));
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ detail: msg }, 502);
  }
});

/** Demo: liquida como pey webhook + timbra CFDI (requiere operador). */
app.post("/api/demo/simular-pago/:id", async (c) => {
  const denied = await guardOperator(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ detail: "id inválido" }, 400);
  }
  try {
    const result = await simularPagoDemo(c.env, publicUrl(c), id);
    return c.json(result);
  } catch (err) {
    const status = (err as Error & { status?: number }).status || 500;
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ detail: msg }, status as 400 | 404 | 409 | 500);
  }
});

app.post("/whatsapp/webhook", async (c) => {
  const form = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") params[k] = v;
  }
  const signed = await verifyTwilioSignature(c.env, c.req.raw, params);
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
      c.env,
      publicUrl(c),
      from,
      body,
      buttonPayload || undefined,
      buttonText || undefined,
    );
  } catch (err) {
    console.log(`[whatsapp] unhandled: ${String(err)}`);
    reply =
      "Ocurrió un error temporal. Reintenta en unos segundos o contacta al comercio.";
    try {
      await sendWhatsapp(c.env, from, reply);
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
  const rawBody = await c.req.text();
  const okSig = await verifyPeyWebhook(c.env, c.req.raw, rawBody);
  if (!okSig) {
    return c.json({ detail: "invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
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
      c.env,
      orden.telefono,
      `💰 Pago confirmado: $${orden.monto} MXN (orden #${orden.id}).`,
    );
    await evaluarYTimbrar(c.env, publicUrl(c), orden.id);
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
  if (!txId) return c.json({ ok: true, ignored: "no transactionId" });

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
  if (!orden) return c.json({ ok: true, ignored: "unknown numRef" });

  const nextEstado =
    Number(orden.requiere_factura) === 1 ? orden.estado_chat : "COMPLETADO";
  await c.env.DB.prepare(
    `UPDATE ordenes SET pago_estado = 'PAGADO', pey_transaction_id = ?, estado_chat = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(String(txId), nextEstado, nowIso(), orden.id)
    .run();

  await sendWhatsapp(
    c.env,
    orden.telefono,
    `💰 Pago CoDi confirmado: $${orden.monto} MXN (orden #${orden.id}).`,
  );
  await evaluarYTimbrar(c.env, publicUrl(c), orden.id);
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
