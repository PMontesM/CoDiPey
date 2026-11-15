import type { Env } from "../types";

export type SatValidationResult = {
  ok: boolean;
  /** Mensajes cortos para WhatsApp (español sencillo). */
  hints: string[];
  /** Cliente Facturapi creado durante la validación (si aplica). */
  customerId?: string;
};

const GENERIC_RFCS = new Set(["XAXX010101000", "XEXX010101000"]);

function auth(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.FACTURAPI_KEY}`,
    "Content-Type": "application/json",
  };
}

/** RFC genérico de público en general / extranjero — no se consulta al SAT. */
export function isGenericRfc(rfc: string): boolean {
  return GENERIC_RFCS.has(rfc.toUpperCase().replace(/\s+/g, ""));
}

/** Consulta lista EFOS (69-B) vía Facturapi. */
export async function checkRfcEfos(
  env: Env,
  rfc: string,
): Promise<{ ok: boolean; hint: string }> {
  if (!env.FACTURAPI_KEY) {
    return { ok: true, hint: "" };
  }
  if (isGenericRfc(rfc)) {
    return { ok: true, hint: "RFC genérico (público en general)." };
  }
  try {
    const res = await fetch(
      `https://www.facturapi.io/v2/tools/tax_id_validation?tax_id=${encodeURIComponent(rfc)}`,
      { headers: { Authorization: `Bearer ${env.FACTURAPI_KEY}` } },
    );
    if (!res.ok) {
      return {
        ok: true,
        hint: "No pude consultar el SAT ahora; seguimos y validamos al final.",
      };
    }
    const data = (await res.json()) as {
      efos?: { is_valid?: boolean; data?: { mensaje?: string } };
    };
    if (data.efos?.is_valid === false) {
      return {
        ok: false,
        hint:
          "⚠️ Este RFC aparece en la lista de incumplidos del SAT (EFOS). " +
          "Mejor pide otra constancia o usa *Sin RFC*.",
      };
    }
    return { ok: true, hint: "✓ RFC sin alertas en la lista del SAT." };
  } catch {
    return {
      ok: true,
      hint: "No pude consultar el SAT ahora; seguimos y validamos al final.",
    };
  }
}

function friendlySatError(code?: string, message?: string): string {
  const map: Record<string, string> = {
    tax_address_zip_mismatch:
      "El código postal no coincide con el RFC en el SAT. Pide que lo lea de su constancia.",
    tax_id_and_legal_name_mismatch:
      "El nombre no coincide con el RFC. Debe ser igual a la constancia (sin S.A. de C.V. a veces).",
    tax_system_not_allowed_for_tax_id:
      "Ese régimen no corresponde a este RFC. Prueba otro de la lista.",
    tax_id_not_found:
      "El SAT no reconoce este RFC. Revisa que esté bien escrito.",
  };
  if (code && map[code]) return map[code];
  if (message && message.length < 160) return message;
  return "El SAT no aceptó estos datos juntos. Revisa RFC, nombre, CP y régimen.";
}

/**
 * Crea el cliente en Facturapi y pide validación SAT.
 * Si falla, borra el cliente de prueba y devuelve hints accionables.
 */
export async function validateFiscalWithSat(
  env: Env,
  data: {
    rfc: string;
    razon_social: string;
    codigo_postal: string;
    regimen: string;
  },
): Promise<SatValidationResult> {
  if (!env.FACTURAPI_KEY) {
    return { ok: true, hints: ["Validación SAT omitida (sin API key)."] };
  }
  if (isGenericRfc(data.rfc)) {
    return { ok: true, hints: ["RFC genérico: no requiere validación SAT."] };
  }

  let customerId: string | undefined;
  try {
    const create = await fetch("https://www.facturapi.io/v2/customers", {
      method: "POST",
      headers: auth(env),
      body: JSON.stringify({
        legal_name: data.razon_social,
        tax_id: data.rfc,
        tax_system: data.regimen,
        address: { zip: data.codigo_postal },
      }),
    });
    const created = (await create.json()) as {
      id?: string;
      message?: string;
      code?: string;
    };
    if (!create.ok || !created.id) {
      return {
        ok: false,
        hints: [
          friendlySatError(
            created.code,
            created.message || (await safeText(create)),
          ),
        ],
      };
    }
    customerId = created.id;

    const val = await fetch(
      `https://www.facturapi.io/v2/customers/${customerId}/tax-info-validation`,
      { headers: { Authorization: `Bearer ${env.FACTURAPI_KEY}` } },
    );
    const body = (await val.json()) as {
      is_valid?: boolean;
      errors?: Array<{ code?: string; message?: string }>;
    };

    if (body.is_valid) {
      return {
        ok: true,
        hints: ["✓ Datos cuadran con el SAT."],
        customerId,
      };
    }

    const hints = (body.errors || [])
      .map((e) => friendlySatError(e.code, e.message))
      .filter(Boolean);
    // dedupe
    const unique = [...new Set(hints.length ? hints : [friendlySatError()])];
    await deleteCustomer(env, customerId);
    return { ok: false, hints: unique };
  } catch (err) {
    if (customerId) await deleteCustomer(env, customerId);
    return {
      ok: false,
      hints: [
        `No pude validar con el SAT ahora (${err instanceof Error ? err.message : "error"}). Intenta de nuevo en un momento.`,
      ],
    };
  }
}

async function deleteCustomer(env: Env, id: string): Promise<void> {
  try {
    await fetch(`https://www.facturapi.io/v2/customers/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.FACTURAPI_KEY}` },
    });
  } catch {
    /* ignore */
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
