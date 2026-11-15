import type { Orden } from "../types";

function fiscalBadge(orden: Orden & Record<string, unknown>): string {
  if (!orden.requiere_factura) return "SIN FACTURA";
  if (orden.facturapi_id) return "TIMBRADO";
  if (orden.estado_chat === "ERROR_FISCAL" || orden.error_fiscal) return "ERROR FISCAL";
  if (!orden.datos_fiscales_ok) return "PENDIENTE DATOS";
  if (orden.pago_estado === "PAGADO") return "LISTO POR TIMBRAR";
  return "DATOS OK";
}

export function buildOrdenesPayload(
  rows: Array<Orden & Record<string, unknown>>,
): {
  kpis: Record<string, number>;
  ordenes: Array<Record<string, unknown>>;
} {
  let totalCobrado = 0;
  let facturas = 0;
  let pendientes = 0;
  const ordenes = rows.map((o) => {
    let conceptos: unknown[] = [];
    try {
      conceptos = JSON.parse(o.conceptos) as unknown[];
    } catch {
      conceptos = [];
    }
    if (o.pago_estado === "PAGADO") totalCobrado += Number(o.monto);
    else pendientes += 1;
    if (o.facturapi_id) facturas += 1;
    return {
      ...o,
      conceptos_parseados: conceptos,
      total: Number(o.monto),
      cp: o.codigo_postal,
      fiscal_badge: fiscalBadge(o),
    };
  });
  return {
    kpis: {
      total_cobrado: totalCobrado,
      facturas_timbradas: facturas,
      comisiones_ahorradas: Math.round(totalCobrado * 0.035 * 100) / 100,
      ordenes_pendientes: pendientes,
    },
    ordenes,
  };
}
