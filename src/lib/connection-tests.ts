import type { Env } from "../types";

export type ConnectionTestId = "pey" | "facturapi" | "twilio";

export type ConnectionTestResult = {
  id: ConnectionTestId;
  ok: boolean;
  status?: number;
  message: string;
};

async function testPey(env: Env): Promise<ConnectionTestResult> {
  const key = (env.PEY_API_KEY || "").trim().replace(/^Bearer\s+/i, "");
  if (!key) {
    return { id: "pey", ok: false, message: "Falta PEY_API_KEY" };
  }
  try {
    // Pedido inválido a propósito: si la key es válida suele ser 4xx de negocio, no 401.
    const res = await fetch("https://api.pey.mx/codi/qr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ amount: 0.01, concept: "ping", expiration: 60, numRef: "0" }),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        id: "pey",
        ok: false,
        status: res.status,
        message: "Key rechazada por pey (401/403)",
      };
    }
    return {
      id: "pey",
      ok: true,
      status: res.status,
      message: `Key aceptada (HTTP ${res.status})`,
    };
  } catch (err) {
    return { id: "pey", ok: false, message: `Red: ${String(err)}` };
  }
}

async function testFacturapi(env: Env): Promise<ConnectionTestResult> {
  const key = (env.FACTURAPI_KEY || "").trim();
  if (!key) {
    return { id: "facturapi", ok: false, message: "Falta FACTURAPI_KEY" };
  }
  try {
    const res = await fetch("https://www.facturapi.io/v2/organizations/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      return {
        id: "facturapi",
        ok: false,
        status: res.status,
        message: `Facturapi HTTP ${res.status}`,
      };
    }
    const org = (await res.json()) as { legal?: { tax_id?: string; name?: string } };
    const rfc = org.legal?.tax_id || "—";
    return {
      id: "facturapi",
      ok: true,
      status: 200,
      message: `OK · emisor ${rfc}`,
    };
  } catch (err) {
    return { id: "facturapi", ok: false, message: `Red: ${String(err)}` };
  }
}

async function testTwilio(env: Env): Promise<ConnectionTestResult> {
  const sid = (env.TWILIO_ACCOUNT_SID || "").trim();
  const token = (env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) {
    return { id: "twilio", ok: false, message: "Falta TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN" };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      {
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        },
      },
    );
    if (!res.ok) {
      return {
        id: "twilio",
        ok: false,
        status: res.status,
        message: `Twilio HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { friendly_name?: string; status?: string };
    return {
      id: "twilio",
      ok: true,
      status: 200,
      message: `OK · ${data.friendly_name || sid} (${data.status || "active"})`,
    };
  } catch (err) {
    return { id: "twilio", ok: false, message: `Red: ${String(err)}` };
  }
}

export async function runConnectionTest(
  env: Env,
  id: ConnectionTestId,
): Promise<ConnectionTestResult> {
  if (id === "pey") return testPey(env);
  if (id === "facturapi") return testFacturapi(env);
  if (id === "twilio") return testTwilio(env);
  return { id: "pey", ok: false, message: "Prueba desconocida" };
}

export async function runAllConnectionTests(
  env: Env,
): Promise<ConnectionTestResult[]> {
  return Promise.all([testPey(env), testFacturapi(env), testTwilio(env)]);
}
