import { Hono } from "hono";
import { buildOrdenesPayload } from "./lib/admin";
import { getBlob } from "./lib/blobs";
import { handleWhatsappMessage } from "./lib/chat";
import { evaluarYTimbrar } from "./lib/facturapi";
import { nowIso, xmlEscape } from "./lib/parse";
import { sendWhatsapp } from "./lib/twilio";
import type { Env, Orden } from "./types";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

function publicUrl(c: { env: Env; req: { url: string } }): string {
  if (c.env.PUBLIC_URL) return c.env.PUBLIC_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

app.get("/health", (c) => c.json({ status: "ok", runtime: "cloudflare-worker" }));

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
  const obj = await getBlob(c.env, key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.data, {
    headers: {
      "content-type": obj.contentType,
      "cache-control": "public, max-age=300",
    },
  });
});

app.get("/api/ordenes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.*,
            COALESCE(c.rfc, c2.rfc) AS rfc,
            COALESCE(c.razon_social, c2.razon_social) AS razon_social,
            COALESCE(c.codigo_postal, c2.codigo_postal) AS codigo_postal,
            COALESCE(c.regimen, c2.regimen) AS regimen,
            COALESCE(c.uso_cfdi, c2.uso_cfdi) AS uso_cfdi
     FROM ordenes o
     LEFT JOIN clientes_fiscales c ON c.id = o.cliente_fiscal_id
     LEFT JOIN clientes_fiscales c2
       ON o.cliente_fiscal_id IS NULL AND c2.telefono = o.telefono
     ORDER BY o.id DESC`,
  ).all<Orden & Record<string, unknown>>();
  return c.json(buildOrdenesPayload(results || []));
});

app.post("/api/ordenes/:id/reintentar-timbrado", async (c) => {
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

app.post("/whatsapp/webhook", async (c) => {
  const form = await c.req.parseBody();
  const body = String(form.Body || "");
  const from = String(form.From || "whatsapp:+0000000000");
  let reply: string;
  try {
    reply = await handleWhatsappMessage(c.env, publicUrl(c), from, body);
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
  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
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

  if (
    event &&
    !["codi.qr.payment_received", "codi.pn.payment_received"].includes(event)
  ) {
    if (!data.transactionId && !data.transaction_id) {
      return c.json({ ok: true, ignored: `event ${event}` });
    }
  }

  const txId = data.transactionId || data.transaction_id || payload.transactionId;
  const numRef = data.numRef || data.num_ref || data.reference || payload.numRef;
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

  await c.env.DB.prepare(
    `UPDATE ordenes SET pago_estado = 'PAGADO', pey_transaction_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(String(txId), nowIso(), orden.id)
    .run();

  await sendWhatsapp(
    c.env,
    orden.telefono,
    `💰 Pago CoDi confirmado: $${orden.monto} MXN (orden #${orden.id}).`,
  );
  await evaluarYTimbrar(c.env, publicUrl(c), orden.id);
  return c.json({ ok: true, orden_id: orden.id, pago: "PAGADO" });
});

export default app;
