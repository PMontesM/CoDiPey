import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
  ]);
}

async function clearDb(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM blobs"),
    db.prepare("DELETE FROM ordenes"),
    db.prepare("DELETE FROM clientes_fiscales"),
  ]);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const request = new IncomingRequest(`https://cobro-codi.test${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

describe("Worker HTTP", () => {
  beforeEach(async () => {
    await migrate(env.DB);
    await clearDb(env.DB);
    const e = env as Record<string, unknown>;
    e.PEY_API_KEY = "test-pey";
    e.FACTURAPI_KEY = "test-facturapi";
    e.TWILIO_ACCOUNT_SID = "";
    e.TWILIO_AUTH_TOKEN = "";
    e.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
    e.PUBLIC_URL = "https://cobro-codi.test";

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

  it("WhatsApp step1 creates order and asks for invoice", async () => {
    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "1 Prueba CoDi 0.01",
      }),
    });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain("Orden #");
    expect(twiml).toMatch(/factura CFDI 4\.0/i);
    expect(twiml).toMatch(/Sí|1/i);

    const row = await env.DB.prepare(
      "SELECT estado_chat, monto FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; monto: string }>();
    expect(row?.estado_chat).toBe("ESPERANDO_FACTURA");
    expect(row?.monto).toBe("0.01");
  });

  it("WhatsApp list picker PROD_ creates order from catalog", async () => {
    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "Prueba CoDi $0.01",
        ButtonPayload: "PROD_PRUEBA_001",
        ButtonText: "Prueba CoDi $0.01",
      }),
    });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain("Orden #");
    expect(twiml).toMatch(/factura CFDI 4\.0/i);

    const row = await env.DB.prepare(
      "SELECT monto, conceptos FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ monto: string; conceptos: string }>();
    expect(row?.monto).toBe("0.01");
    expect(row?.conceptos).toContain("Prueba CoDi");
  });

  it("WhatsApp button payload FACTURA_SI advances like tapping Sí", async () => {
    await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "1 Prueba CoDi 0.01",
      }),
    });

    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "Sí, factura",
        ButtonPayload: "FACTURA_SI",
        ButtonText: "Sí, factura",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/QR CoDi|\/files\/qr_/);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, requiere_factura FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; requiere_factura: number }>();
    expect(orden?.requiere_factura).toBe(1);
    expect(orden?.estado_chat).toBe("ESPERANDO_DATOS_FISCALES");
  });

  it("WhatsApp 1 generates CoDi QR via pey and stores PNG", async () => {
    await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "1 Prueba CoDi 0.01",
      }),
    });

    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ From: "whatsapp:+5215510076571", Body: "1" }),
    });
    const text = await res.text();
    // Sin credenciales Twilio en test: TwiML trae el link; con Twilio sería Response vacío + MediaUrl
    expect(text).toMatch(/QR CoDi|\/files\/qr_\d+\.png/);

    const orden = await env.DB.prepare(
      "SELECT estado_chat, pey_qr_id FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ estado_chat: string; pey_qr_id: string }>();
    expect(orden?.estado_chat).toBe("ESPERANDO_DATOS_FISCALES");
    expect(orden?.pey_qr_id).toBe("qr_test_1");

    const blob = await env.DB.prepare(
      "SELECT key FROM blobs WHERE key LIKE 'qr_%'",
    ).first();
    expect(blob).toBeTruthy();
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
    const res1 = await call("/pey/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(await res1.json()).toMatchObject({
      ok: true,
      pago: "PAGADO",
      orden_id: orden!.id,
    });

    const res2 = await call("/pey/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(await res2.json()).toMatchObject({
      ok: true,
      duplicate: true,
      orden_id: orden!.id,
    });
  });

  it("hola opens product menu with catalog options", async () => {
    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ From: "whatsapp:+5215510076571", Body: "hola" }),
    });
    const twiml = await res.text();
    expect(twiml).toMatch(/Cobro CoDi|productos|pedido/i);
    expect(twiml).toMatch(/Prueba CoDi/i);
  });

  it("rejects gibberish with helpful TwiML", async () => {
    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ From: "whatsapp:+5215510076571", Body: "asdfqwer" }),
    });
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

    const res = await call("/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        From: "whatsapp:+5215510076571",
        Body: "XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03",
      }),
    });
    const text = await res.text();
    expect(text).toMatch(/factura timbrada|Datos fiscales guardados/i);

    const orden = await env.DB.prepare(
      "SELECT facturapi_id, estado_chat FROM ordenes ORDER BY id DESC LIMIT 1",
    ).first<{ facturapi_id: string; estado_chat: string }>();
    expect(orden?.facturapi_id).toBe("inv_test_1");
    expect(orden?.estado_chat).toBe("COMPLETADO");
  });
});
