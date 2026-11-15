import type { Env, Orden } from "../types";

export type EmisorFiscal = {
  rfc: string;
  razon_social: string;
  regimen: string;
  codigo_postal: string;
};

const FALLBACK_EMISOR: EmisorFiscal = {
  rfc: "XIA190128J61",
  razon_social: "GRUPO SANDA",
  regimen: "601",
  codigo_postal: "06010",
};

let emisorCache: { at: number; data: EmisorFiscal } | null = null;

export async function resolveEmisor(env: Env): Promise<EmisorFiscal> {
  if (emisorCache && Date.now() - emisorCache.at < 5 * 60 * 1000) {
    return emisorCache.data;
  }
  if (!env.FACTURAPI_KEY) {
    emisorCache = { at: Date.now(), data: FALLBACK_EMISOR };
    return FALLBACK_EMISOR;
  }
  try {
    const res = await fetch("https://www.facturapi.io/v2/organizations/me", {
      headers: { Authorization: `Bearer ${env.FACTURAPI_KEY}` },
    });
    if (res.ok) {
      const org = (await res.json()) as {
        legal?: {
          tax_id?: string;
          legal_name?: string;
          name?: string;
          tax_system?: string;
          address?: { zip?: string };
        };
      };
      const legal = org.legal || {};
      const data: EmisorFiscal = {
        rfc: String(legal.tax_id || FALLBACK_EMISOR.rfc),
        razon_social: String(
          legal.legal_name || legal.name || FALLBACK_EMISOR.razon_social,
        ),
        regimen: String(legal.tax_system || FALLBACK_EMISOR.regimen),
        codigo_postal: String(
          legal.address?.zip || FALLBACK_EMISOR.codigo_postal,
        ),
      };
      emisorCache = { at: Date.now(), data };
      return data;
    }
  } catch {
    /* fallback */
  }
  emisorCache = { at: Date.now(), data: FALLBACK_EMISOR };
  return FALLBACK_EMISOR;
}

function fiscalBadge(orden: Orden & Record<string, unknown>): string {
  if (!orden.requiere_factura) return "SIN FACTURA";
  if (orden.facturapi_id) return "TIMBRADO";
  if (orden.estado_chat === "ERROR_FISCAL" || orden.error_fiscal)
    return "ERROR FISCAL";
  if (!orden.datos_fiscales_ok) return "PENDIENTE DATOS";
  if (orden.pago_estado === "PAGADO") return "LISTO POR TIMBRAR";
  return "DATOS OK";
}

export function buildOrdenesPayload(
  rows: Array<Orden & Record<string, unknown>>,
  emisor: EmisorFiscal = FALLBACK_EMISOR,
): {
  emisor: EmisorFiscal;
  kpis: Record<string, number>;
  ordenes: Array<Record<string, unknown>>;
} {
  let totalCobrado = 0;
  let facturas = 0;
  let pendientes = 0;
  const ordenes = rows.map((o) => {
    let conceptos: unknown[] = [];
    try {
      conceptos = JSON.parse(String(o.conceptos)) as unknown[];
    } catch {
      conceptos = [];
    }
    if (o.pago_estado === "PAGADO") totalCobrado += Number(o.monto);
    else if (
      o.pago_estado !== "CANCELADO" &&
      o.estado_chat !== "CANCELADO" &&
      o.estado_chat !== "COMPLETADO"
    ) {
      pendientes += 1;
    }
    if (o.facturapi_id) facturas += 1;

    const hasFiscal =
      Number(o.requiere_factura) === 1 || Number(o.datos_fiscales_ok) === 1;

    return {
      ...o,
      conceptos_parseados: conceptos,
      total: Number(o.monto),
      cp: hasFiscal ? o.codigo_postal : null,
      rfc: hasFiscal ? o.rfc : null,
      razon_social: hasFiscal ? o.razon_social : null,
      regimen: hasFiscal ? o.regimen : null,
      uso_cfdi: hasFiscal ? o.uso_cfdi : null,
      cfdi_uuid: o.cfdi_uuid || null,
      fiscal_badge: fiscalBadge(o),
    };
  });
  return {
    emisor,
    kpis: {
      total_cobrado: totalCobrado,
      facturas_timbradas: facturas,
      comisiones_ahorradas: Math.round(totalCobrado * 0.035 * 100) / 100,
      ordenes_pendientes: pendientes,
    },
    ordenes,
  };
}
