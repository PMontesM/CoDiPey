import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  signPeyWebhookForTest,
  signTwilioRequestForTest,
} from "../src/lib/security";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const ADMIN_SECRET = "test-admin-secret";
const TWILIO_TOKEN = "test-twilio-token";
const PEY_WHSEC = "whsec_dGVzdC1wZXktd2ViaG9vay1zZWNyZXQ"; // base64("test-pey-webhook-secret")
const PUBLIC_BASE = "https://cobro-codi.test";

const PNG_1X1 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0,
  0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 8, 215,
  99, 248, 207, 192, 0, 0, 0, 3, 0, 1, 0, 5, 254, 210, 239, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

async function migrate(db: D1Database) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS clientes_fiscales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT NOT NULL UNIQUE,
        rfc TEXT NOT NULL,
        razon_social TEXT NOT NULL,
        codigo_postal TEXT NOT NULL,
        regimen TEXT NOT NULL,
        uso_cfdi TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ordenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT NOT NULL,
        conceptos TEXT NOT NULL,
        monto TEXT NOT NULL,
        concepto_pey TEXT,
        pago_estado TEXT NOT NULL DEFAULT 'PENDIENTE',
        requiere_factura INTEGER NOT NULL DEFAULT 0,
        datos_fiscales_ok INTEGER NOT NULL DEFAULT 0,
        facturapi_id TEXT,
        cfdi_uuid TEXT,
        pey_transaction_id TEXT UNIQUE,
        pey_qr_id TEXT,
        pey_payment_url TEXT,
        estado_chat TEXT NOT NULL DEFAULT 'ESPERANDO_PRODUCTOS',
        error_fiscal TEXT,
        cliente_fiscal_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS blobs (
        key TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS demo_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT NOT NULL,
        e164 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sms_enviado INTEGER NOT NULL DEFAULT 0,
        sms_error TEXT
      )`),
  ]);
}

async function clearDb(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM blobs"),
    db.prepare("DELETE FROM ordenes"),
    db.prepare("DELETE FROM clientes_fiscales"),
    db.prepare("DELETE FROM demo_whatsapp"),
  ]);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("x-admin-token") && !headers.has("authorization")) {
    headers.set("x-admin-token", ADMIN_SECRET);
  }
  const request = new IncomingRequest(`${PUBLIC_BASE}${path}`, {
    ...init,
    headers,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

async function callWhatsapp(data: Record<string, string>): Promise<Response> {
  const body = formBody(data);
  const sig = await signTwilioRequestForTest(
    TWILIO_TOKEN,
    `${PUBLIC_BASE}/whatsapp/webhook`,
    data,
  );
  return call("/whatsapp/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": sig,
    },
    body,
  });
}

async function callPeyWebhook(
  payload: Record<string, unknown>,
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const msgId = `msg_${Math.random().toString(16).slice(2)}`;
  const sig = await signPeyWebhookForTest(PEY_WHSEC, msgId, ts, raw);
  return call("/pey/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": ts,
      "webhook-signature": sig,
    },
    body: raw,
  });
}

describe("Worker HTTP", () => {
  beforeEach(async () => {
    await migrate(env.DB);
    await clearDb(env.DB);
    const e = env as Record<string, unknown>;
    e.PEY_API_KEY = "test-pey";
    e.PEY_WEBHOOK_SECRET = PEY_WHSEC;
    e.FACTURAPI_KEY = "test-facturapi";
    e.TWILIO_ACCOUNT_SID = "";
    e.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
    e.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
    e.ADMIN_API_SECRET = ADMIN_SECRET;
    e.FILE_SIGNING_SECRET = "test-file-signing";
    e.PUBLIC_URL = PUBLIC_BASE;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("api.pey.mx/codi/qr") && (init?.method || "GET") === "POST") {
          return Response.json({
            id: "qr_test_1",
            qrString: '{"TYP":20,"ic":{"IDC":"qr_test_1"}}',
          });
        }
        if (url.includes("api.qrserver.com")) {
          return new Response(PNG_1X1, {
            headers: { "content-type": "image/png" },
          });
        }
        if (url.includes("www.facturapi.io/v2/tools/tax_id_validation")) {
          return Response.json({
            efos: { is_valid: true, data: { mensaje: "ok", detalles: [] } },
          });
        }
        if (
          url.includes("www.facturapi.io/v2/customers") &&
          url.includes("tax-info-validation")
        ) {
          return Response.json({ is_valid: true, errors: [] });
        }
        if (
          url.includes("www.facturapi.io/v2/customers") &&
          (init?.method || "GET") === "POST"
        ) {
          return Response.json({ id: "cus_test_1" });
        }
        if (
          url.includes("www.facturapi.io/v2/customers/") &&
          (init?.method || "") === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        if (url.includes("www.facturapi.io/v2/invoices") && !url.includes("/pdf") && !url.includes("/xml")) {
          return Response.json({ id: "inv_test_1" });
        }
        if (url.includes("/pdf")) {
          return new Response("%PDF-test", {
            headers: { "content-type": "application/pdf" },
          });
        }
        if (url.includes("/xml")) {
          return new Response("<xml/>", {
            headers: { "content-type": "application/xml" },
          });
        }
        return new Response(`unmocked ${url}`, { status: 500 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /health", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects unsigned pey webhook", async () => {
    const res = await call("/pey/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "codi.qr.payment_received",
        data: { transactionId: "tx-forge", numRef: "1" },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unsigned whatsapp webhook", async () => {
    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ From: "whatsapp:+5215510076571", Body: "hola" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects admin APIs without operator auth", async () => {
    const request = new IncomingRequest(`${PUBLIC_BASE}/api/ordenes`);
    const ctx = createExecutionContext();
    const bare = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(bare.status).toBe(401);
  });

  it("blocks factura files without signature", async () => {
    await env.DB.prepare(
      `INSERT INTO blobs (key, content_type, data, updated_at)
       VALUES ('factura_9.pdf', 'application/pdf', ?, ?)`,
    )
      .bind(PNG_1X1, new Date().toISOString())
      .run();
    const denied = await call("/files/factura_9.pdf");
    expect(denied.status).toBe(403);
  });

  async function startCartAndCheckout(from = "whatsapp:+5215510076571") {
    await callWhatsapp({
        From: from,
        Body: "1 Prueba CoDi 0.01",
      });
    await callWhatsapp({
        From: from,
        Body: "Cobrar",
        ButtonPayload: "CART_PAY",
        ButtonText: "Cobrar",
      });
  }

  it("WhatsApp step1 opens cart before invoice", async () => {
    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "1 Prueba CoDi 0.01",
      });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toMatch(/orden #\d+/i);
    expect(twiml).toMatch(/Pedido en curso|Cobrar|Agregar más/i);

    const row = await env.DB.prepare(
      "SELECT estado_chat, monto FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; monto: string }>();
    expect(row?.estado_chat).toBe("ARMAR_PEDIDO");
    expect(row?.monto).toBe("0.01");
  });

  it("WhatsApp cart accepts several products then checkout", async () => {
    await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "1 Cafe 45",
      });
    const add = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "2 Agua 10",
      });
    expect(await add.text()).toMatch(/Cafe|Agua|55\.00|Total/i);

    const row = await env.DB.prepare(
      "SELECT monto, conceptos, estado_chat FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ monto: string; conceptos: string; estado_chat: string }>();
    expect(row?.estado_chat).toBe("ARMAR_PEDIDO");
    expect(row?.monto).toBe("65.00");
    expect(row?.conceptos).toContain("Cafe");
    expect(row?.conceptos).toContain("Agua");

    const pay = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Cobrar",
        ButtonPayload: "CART_PAY",
      });
    expect(await pay.text()).toMatch(/necesita factura|factura/i);
    const after = await env.DB.prepare(
      "SELECT estado_chat FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string }>();
    expect(after?.estado_chat).toBe("ESPERANDO_FACTURA");
  });

  it("WhatsApp list picker PROD_ adds catalog item to cart", async () => {
    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Prueba CoDi $0.01",
        ButtonPayload: "PROD_PRUEBA_001",
        ButtonText: "Prueba CoDi $0.01",
      });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toMatch(/orden #\d+/i);
    expect(twiml).toMatch(/Pedido en curso|Cobrar/i);

    const row = await env.DB.prepare(
      "SELECT monto, conceptos, estado_chat FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ monto: string; conceptos: string; estado_chat: string }>();
    expect(row?.estado_chat).toBe("ARMAR_PEDIDO");
    expect(row?.monto).toBe("0.01");
    expect(row?.conceptos).toContain("Prueba CoDi");
  });

  it("WhatsApp FACTURA_SI asks fiscal first without sending QR", async () => {
    await startCartAndCheckout();

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Sí, factura",
        ButtonPayload: "FACTURA_SI",
        ButtonText: "Sí, factura",
      });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toMatch(/Sin RFC|factura|QR de pago llega al final/i);
    expect(twiml).not.toMatch(/\/files\/qr_/);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, requiere_factura, pey_qr_id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{
      estado_chat: string;
      requiere_factura: number;
      pey_qr_id: string | null;
    }>();
    expect(orden?.requiere_factura).toBe(1);
    expect(orden?.estado_chat).toBe("ESPERANDO_DATOS_FISCALES");
    expect(orden?.pey_qr_id).toBeNull();
  });

  it("WhatsApp Solo pagar generates CoDi QR immediately", async () => {
    await startCartAndCheckout();

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Solo pagar",
        ButtonPayload: "FACTURA_NO",
      });
    const text = await res.text();
    expect(text).toMatch(/Ticket de cobro|Ticket CoDiPey|QR CoDi|\/ticket\/\d+|\/files\/qr_\d+\.png/);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, pey_qr_id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; pey_qr_id: string }>();
    expect(orden?.estado_chat).toBe("ESPERANDO_PAGO");
    expect(orden?.pey_qr_id).toBe("qr_test_1");

    const blob = await env.DB.prepare(
      "SELECT key FROM blobs WHERE key LIKE 'qr_%'",
    ).first();
    expect(blob).toBeTruthy();
  });

  it("POST /api/ordenes/:id/cancelar marks order cancelled", async () => {
    const ts = new Date().toISOString();
    const inserted = await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         estado_chat, created_at, updated_at)
       VALUES (?, ?, '45.00', 'PENDIENTE', 0, 0, 'ESPERANDO_PAGO', ?, ?)`,
    )
      .bind(
        "whatsapp:+5215510076571",
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Cafe",
            precio_unitario: "45",
            subtotal: "45.00",
          },
        ]),
        ts,
        ts,
      )
      .run();
    const id = Number(inserted.meta.last_row_id);

    const res = await call(`/api/ordenes/${id}/cancelar`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orden.estado_chat).toBe("CANCELADO");
    expect(body.orden.pago_estado).toBe("CANCELADO");

    const list = await call("/api/ordenes");
    const payload = await list.json();
    expect(payload.kpis.ordenes_pendientes).toBe(0);
  });

  it("WhatsApp cancelar ends active cobro", async () => {
    await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "1 Cafe 45",
      });
    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "cancelar",
        ButtonPayload: "CANCEL",
      });
    expect(await res.text()).toMatch(/cancelada/i);
    const orden = await env.DB.prepare(
      "SELECT estado_chat, pago_estado FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; pago_estado: string }>();
    expect(orden?.estado_chat).toBe("CANCELADO");
    expect(orden?.pago_estado).toBe("CANCELADO");
  });

  it("WhatsApp Sin RFC after factura releases QR at the end", async () => {
    await startCartAndCheckout();
    await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Sí, factura",
        ButtonPayload: "FACTURA_SI",
      });

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Sin RFC",
        ButtonPayload: "FISCAL_DEMO",
      });
    expect(await res.text()).toMatch(/Ticket de cobro|QR CoDi|\/ticket\/\d+|\/files\/qr_/);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, pey_qr_id, datos_fiscales_ok FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{
      estado_chat: string;
      pey_qr_id: string;
      datos_fiscales_ok: number;
    }>();
    expect(orden?.datos_fiscales_ok).toBe(1);
    expect(orden?.pey_qr_id).toBe("qr_test_1");
    expect(orden?.estado_chat).toBe("ESPERANDO_PAGO");
  });

  it("pey webhook marks PAGADO idempotently", async () => {
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         estado_chat, created_at, updated_at)
       VALUES (?, ?, '0.01', 'PENDIENTE', 0, 0, 'ESPERANDO_PAGO', ?, ?)`,
    )
      .bind(
        "whatsapp:+5215510076571",
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Prueba",
            precio_unitario: "0.01",
            subtotal: "0.01",
          },
        ]),
        ts,
        ts,
      )
      .run();
    const orden = await env.DB.prepare(
      "SELECT id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ id: number }>();

    const body = {
      event: "codi.qr.payment_received",
      data: { transactionId: "tx-e2e-1", numRef: String(orden!.id) },
    };
    const res1 = await callPeyWebhook(body);
    expect(await res1.json()).toMatchObject({
      ok: true,
      pago: "PAGADO",
      orden_id: orden!.id,
    });

    const res2 = await callPeyWebhook(body);
    expect(await res2.json()).toMatchObject({
      ok: true,
      duplicate: true,
      orden_id: orden!.id,
    });
  });

  it("pey webhook liquida payment_link.status_updated paid", async () => {
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         estado_chat, created_at, updated_at)
       VALUES (?, ?, '10.00', 'PENDIENTE', 0, 0, 'ESPERANDO_PAGO', ?, ?)`,
    )
      .bind(
        "whatsapp:+5215510076571",
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Link",
            precio_unitario: "10.00",
            subtotal: "10.00",
          },
        ]),
        ts,
        ts,
      )
      .run();
    const orden = await env.DB.prepare(
      "SELECT id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ id: number }>();

    const res = await callPeyWebhook({
        type: "payment_link.status_updated",
        status: "paid",
        clientReferenceId: String(orden!.id),
        paymentLinkId: "01LINKTEST",
        transactions: [{ transactionId: "tx-link-1", amount: 10 }],
      });
    expect(await res.json()).toMatchObject({
      ok: true,
      pago: "PAGADO",
      orden_id: orden!.id,
      via: "payment_link",
    });

    const pending = await callPeyWebhook({
        type: "payment_link.status_updated",
        status: "pending",
        clientReferenceId: String(orden!.id),
        transactions: [{ transactionId: "tx-link-2" }],
      });
    expect(await pending.json()).toMatchObject({
      ok: true,
      ignored: "payment_link pending",
    });
  });

  it("hola opens product menu with catalog options", async () => {
    const res = await callWhatsapp({ From: "whatsapp:+5215510076571", Body: "hola" });
    const twiml = await res.text();
    expect(twiml).toMatch(/Cobro CoDi|productos|pedido/i);
    expect(twiml).toMatch(/Prueba CoDi/i);
  });

  it("WhatsApp STATUS reports active order", async () => {
    await startCartAndCheckout();
    await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Solo pagar",
        ButtonPayload: "FACTURA_NO",
      });

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Estado del cobro",
        ButtonPayload: "STATUS",
      });
    const twiml = await res.text();
    expect(twiml).toMatch(/Orden #|Vigencia|QR/i);
  });

  it("WhatsApp Otros datos with saved RFC starts wizard", async () => {
    const ts = new Date().toISOString();
    const phone = "whatsapp:+5215511229988";
    const fiscal = await env.DB.prepare(
      `INSERT INTO clientes_fiscales
        (telefono, rfc, razon_social, codigo_postal, regimen, uso_cfdi, updated_at)
       VALUES (?, 'URE180429TM6', 'UNIVERSIDAD ROBOTICA ESPAÑOLA', '86991', '601', 'G03', ?)`,
    )
      .bind(phone, ts)
      .run();
    const fiscalId = Number(fiscal.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         cliente_fiscal_id, estado_chat, created_at, updated_at)
       VALUES (?, ?, '45.00', 'PENDIENTE', 1, 1, ?, 'ESPERANDO_DATOS_FISCALES', ?, ?)`,
    )
      .bind(
        phone,
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Cafe",
            precio_unitario: "45.00",
            subtotal: "45.00",
          },
        ]),
        fiscalId,
        ts,
        ts,
      )
      .run();

    const res = await callWhatsapp({
        From: phone,
        Body: "Otros datos",
        ButtonPayload: "FISCAL_EDIT",
      });
    expect(await res.text()).toMatch(/Paso 1 de 5|RFC/i);
    const orden = await env.DB.prepare(
      "SELECT estado_chat FROM ordenes WHERE telefono = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(phone)
      .first<{ estado_chat: string }>();
    expect(orden?.estado_chat).toBe("ESPERANDO_FISCAL_RFC");
  });

  it("WhatsApp Sí tengo RFC starts step-by-step wizard", async () => {
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         pey_qr_id, estado_chat, created_at, updated_at)
       VALUES (?, ?, '0.01', 'PENDIENTE', 1, 0, 'qr_x', 'ESPERANDO_DATOS_FISCALES', ?, ?)`,
    )
      .bind(
        "whatsapp:+5215510076571",
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Prueba",
            precio_unitario: "0.01",
            subtotal: "0.01",
          },
        ]),
        ts,
        ts,
      )
      .run();

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "Sí tengo RFC",
        ButtonPayload: "FISCAL_EDIT",
      });
    const twiml = await res.text();
    expect(twiml).toMatch(/Paso 1 de 5|RFC/i);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, datos_fiscales_ok FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; datos_fiscales_ok: number }>();
    expect(orden?.estado_chat).toBe("ESPERANDO_FISCAL_RFC");
    expect(orden?.datos_fiscales_ok).toBe(0);
  });

  it("WhatsApp fiscal wizard completes with buttons and text", async () => {
    const ts = new Date().toISOString();
    const phone = "whatsapp:+5215510076571";
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         pey_qr_id, estado_chat, created_at, updated_at)
       VALUES (?, ?, '0.01', 'PENDIENTE', 1, 0, NULL, 'ESPERANDO_DATOS_FISCALES', ?, ?)`,
    )
      .bind(
        phone,
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Prueba",
            precio_unitario: "0.01",
            subtotal: "0.01",
          },
        ]),
        ts,
        ts,
      )
      .run();

    await callWhatsapp({ From: phone, Body: "tengo rfc", ButtonPayload: "FISCAL_EDIT" });
    await callWhatsapp({ From: phone, Body: "XAXX010101000" });
    await callWhatsapp({ From: phone, Body: "PUBLICO EN GENERAL" });
    await callWhatsapp({ From: phone, Body: "06600" });
    await callWhatsapp({
        From: phone,
        Body: "RESICO (fácil)",
        ButtonPayload: "REG_616",
      });
    const res = await callWhatsapp({
        From: phone,
        Body: "Gastos en general",
        ButtonPayload: "USO_G03",
      });
    expect(await res.text()).toMatch(/Ticket de cobro|QR CoDi|Datos listos|factura listos|\/ticket\/\d+|\/files\/qr_/i);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, datos_fiscales_ok, pey_qr_id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{
      estado_chat: string;
      datos_fiscales_ok: number;
      pey_qr_id: string | null;
    }>();
    expect(orden?.datos_fiscales_ok).toBe(1);
    expect(orden?.pey_qr_id).toBe("qr_test_1");
    expect(orden?.estado_chat).toBe("ESPERANDO_PAGO");
  });

  it("rejects gibberish with helpful TwiML", async () => {
    const res = await callWhatsapp({ From: "whatsapp:+5215510076571", Body: "asdfqwer" });
    expect(await res.text()).toMatch(/No entendí|menú|cantidad concepto/i);
  });

  it("fiscal data + paid order stamps CFDI", async () => {
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ordenes
        (telefono, conceptos, monto, pago_estado, requiere_factura, datos_fiscales_ok,
         estado_chat, created_at, updated_at)
       VALUES (?, ?, '0.01', 'PAGADO', 1, 0, 'ESPERANDO_DATOS_FISCALES', ?, ?)`,
    )
      .bind(
        "whatsapp:+5215510076571",
        JSON.stringify([
          {
            cantidad: "1",
            concepto: "Prueba",
            precio_unitario: "0.01",
            subtotal: "0.01",
          },
        ]),
        ts,
        ts,
      )
      .run();

    const res = await callWhatsapp({
        From: "whatsapp:+5215510076571",
        Body: "XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03",
      });
    const text = await res.text();
    expect(text).toMatch(/factura timbrada|Datos fiscales guardados/i);

    const orden = await env.DB.prepare(
      "SELECT facturapi_id, estado_chat FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ facturapi_id: string; estado_chat: string }>();
    expect(orden?.facturapi_id).toBe("inv_test_1");
    expect(orden?.estado_chat).toBe("COMPLETADO");
  });

  it("POST /api/demo/simular-cobro creates pending order with QR", async () => {
    const res = await call("/api/demo/simular-cobro", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orden.pago_estado).toBe("PENDIENTE");
    expect(body.orden.pey_qr_id).toBe("qr_test_1");
    expect(body.orden.requiere_factura).toBe(1);
    expect(body.qr_url).toMatch(/^\/files\/qr_\d+\.png$/);

    const blob = await env.DB.prepare(
      "SELECT key FROM blobs WHERE key LIKE 'qr_%'",
    ).first();
    expect(blob).toBeTruthy();

    const ticket = await call(`/ticket/${body.orden.id}`);
    expect(ticket.status).toBe(200);
    const html = await ticket.text();
    expect(html).toMatch(/TICKET DE COBRO/);
    expect(html).toMatch(/ESCANEA PARA PAGAR/);
    expect(html).toMatch(/qr_code_\d+\.png|qr_\d+\.png/);
  });

  it("POST /api/demo/simular-pago/:id liquidates and stamps CFDI", async () => {
    const created = await call("/api/demo/simular-cobro", { method: "POST" });
    const { orden } = await created.json();
    const res = await call(`/api/demo/simular-pago/${orden.id}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orden.pago_estado).toBe("PAGADO");
    expect(body.orden.facturapi_id).toBe("inv_test_1");
    expect(body.message).toMatch(/timbrado/i);
  });

  it("GET /api/demo/whatsapp-join reports config", async () => {
    const e = env as Record<string, unknown>;
    e.TWILIO_SANDBOX_JOIN_CODE = "demo-join";
    const res = await call("/api/demo/whatsapp-join");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.join_text).toBe("join demo-join");
    expect(body.wa_link).toContain("wa.me/");
    expect(body.wa_link).toContain(encodeURIComponent("join demo-join"));
  });

  it("POST /api/demo/registrar-whatsapp returns wa.me link", async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS demo_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT NOT NULL,
        e164 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sms_enviado INTEGER NOT NULL DEFAULT 0,
        sms_error TEXT
      )`,
    ).run();
    const e = env as Record<string, unknown>;
    e.TWILIO_SANDBOX_JOIN_CODE = "demo-join";
    e.TWILIO_SMS_FROM = "";
    const res = await call("/api/demo/registrar-whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telefono: "5512345678" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.e164).toBe("+525512345678");
    expect(body.join_text).toBe("join demo-join");
    expect(body.wa_link).toContain("wa.me/14155238886");
    expect(body.sms_enviado).toBe(false);
    const row = await env.DB.prepare(
      "SELECT e164 FROM demo_whatsapp ORDER BY id DESC LIMIT 1",
    ).first<{ e164: string }>();
    expect(row?.e164).toBe("+525512345678");
  });

  describe("e2e WhatsApp flows", () => {
    const phone = "whatsapp:+5215599001122";

    async function wa(data: Record<string, string>) {
      return callWhatsapp({ From: phone, ...data });
    }

    async function latestOrden() {
      return env.DB.prepare(
        "SELECT * FROM ordenes WHERE telefono = ? ORDER BY id DESC LIMIT 1",
      )
        .bind(phone)
        .first<Record<string, unknown>>();
    }

    it("e2e: producto → carrito → cobrar → solo pagar → QR (sin factura)", async () => {
      let res = await wa({
        Body: "Prueba CoDi $0.01 Demo de liquidación Banxico",
        ButtonPayload: "PROD_PRUEBA_001",
        ButtonText: "Prueba CoDi $0.01",
      });
      expect(await res.text()).toMatch(/Pedido en curso|Cobrar/i);
      expect((await latestOrden())?.estado_chat).toBe("ARMAR_PEDIDO");

      res = await wa({
        Body: "Cobrar",
        ButtonPayload: "CART_PAY",
        ButtonText: "Cobrar",
      });
      expect(await res.text()).toMatch(/factura/i);
      expect((await latestOrden())?.estado_chat).toBe("ESPERANDO_FACTURA");

      res = await wa({
        Body: "Solo pagar",
        ButtonPayload: "FACTURA_NO",
        ButtonText: "Solo pagar",
      });
      const twiml = await res.text();
      expect(twiml).toMatch(/QR|ticket|orden #|Escanea|Pagar/i);
      const orden = await latestOrden();
      expect(orden?.estado_chat).toBe("ESPERANDO_PAGO");
      expect(orden?.pey_qr_id).toBeTruthy();
      expect(orden?.requiere_factura).toBe(0);
    });

    it("e2e: sí factura → Sin RFC → QR", async () => {
      await startCartAndCheckout(phone);
      let res = await wa({
        Body: "Sí, factura",
        ButtonPayload: "FACTURA_SI",
      });
      expect(await res.text()).toMatch(/Sin RFC|tengo RFC|Factura/i);

      res = await wa({
        Body: "Sin RFC",
        ButtonPayload: "FISCAL_DEMO",
      });
      const twiml = await res.text();
      expect(twiml).toMatch(/QR|ticket|orden #|Escanea|Pagar|Sin factura|datos/i);
      const orden = await latestOrden();
      expect(orden?.pey_qr_id).toBeTruthy();
      expect(orden?.requiere_factura).toBe(1);
      expect(orden?.datos_fiscales_ok).toBe(1);
    });

    it("e2e: durante RFC, tap PROD_ no se trata como RFC (abre carrito)", async () => {
      await startCartAndCheckout(phone);
      await wa({ Body: "Sí, factura", ButtonPayload: "FACTURA_SI" });
      await wa({ Body: "Sí tengo RFC", ButtonPayload: "FISCAL_EDIT" });
      expect((await latestOrden())?.estado_chat).toBe("ESPERANDO_FISCAL_RFC");

      // Tap de lista vieja de productos (regresión del bug del screenshot)
      const res = await wa({
        Body: "Prueba CoDi $0.01 Demo de liquidación Banxico",
        ButtonPayload: "PROD_PRUEBA_001",
        ButtonText: "Prueba CoDi $0.01",
      });
      const twiml = await res.text();
      expect(twiml).not.toMatch(/Ese RFC no se ve completo/i);
      expect(twiml).toMatch(/Pedido en curso|Cobrar/i);

      const orden = await latestOrden();
      expect(orden?.estado_chat).toBe("ARMAR_PEDIDO");
      expect(orden?.monto).toBe("0.01");
    });

    it("e2e: Menú en wizard cancela fiscal y muestra catálogo", async () => {
      await startCartAndCheckout(phone);
      await wa({ Body: "Sí, factura", ButtonPayload: "FACTURA_SI" });
      await wa({ Body: "Sí tengo RFC", ButtonPayload: "FISCAL_EDIT" });

      const res = await wa({
        Body: "Menú",
        ButtonPayload: "MENU",
        ButtonText: "Menú",
      });
      expect(await res.text()).toMatch(/productos|Cobrar|Café|Prueba|menú|Menú/i);

      const prev = await env.DB.prepare(
        `SELECT estado_chat, pago_estado FROM ordenes
         WHERE telefono = ? AND estado_chat = 'CANCELADO'
         ORDER BY id DESC LIMIT 1`,
      )
        .bind(phone)
        .first<{ estado_chat: string; pago_estado: string }>();
      expect(prev?.pago_estado).toBe("CANCELADO");
    });

    it("e2e: RFC inválido re-pide RFC (no solo empezar de nuevo)", async () => {
      await startCartAndCheckout(phone);
      await wa({ Body: "Sí, factura", ButtonPayload: "FACTURA_SI" });
      await wa({ Body: "Sí tengo RFC", ButtonPayload: "FISCAL_EDIT" });

      const res = await wa({ Body: "ABC" });
      const twiml = await res.text();
      expect(twiml).toMatch(/RFC|12 o 13|Paso 1/i);
      expect(twiml).toMatch(/Menú|Sin RFC/i);
      expect((await latestOrden())?.estado_chat).toBe("ESPERANDO_FISCAL_RFC");
    });

    it("e2e: wizard completo con XAXX llega a QR", async () => {
      await startCartAndCheckout(phone);
      await wa({ Body: "Sí, factura", ButtonPayload: "FACTURA_SI" });
      await wa({ Body: "Sí tengo RFC", ButtonPayload: "FISCAL_EDIT" });
      await wa({ Body: "XAXX010101000" });
      await wa({ Body: "PUBLICO EN GENERAL" });
      await wa({ Body: "06600" });
      await wa({
        Body: "Sin obligaciones",
        ButtonPayload: "REG_616",
      });
      const res = await wa({
        Body: "Sin efectos fiscales",
        ButtonPayload: "USO_S01",
      });
      const twiml = await res.text();
      expect(twiml).toMatch(/QR|ticket|orden #|Escanea|Pagar|guardados|genérico/i);
      const orden = await latestOrden();
      expect(orden?.pey_qr_id).toBeTruthy();
      expect(orden?.datos_fiscales_ok).toBe(1);
    });
  });
});
