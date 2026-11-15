import type { ClienteFiscal, Env, Item, Orden } from "../types";
import { putBlob } from "./blobs";
import { nowIso } from "./parse";
import { sendWhatsapp } from "./twilio";

export class FacturapiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function timbrarFacturapi(
  env: Env,
  fiscal: ClienteFiscal,
  items: Item[],
): Promise<Record<string, unknown>> {
  const payload = {
    customer: {
      legal_name: fiscal.razon_social,
      tax_id: fiscal.rfc,
      tax_system: fiscal.regimen,
      address: { zip: fiscal.codigo_postal },
    },
    items: items.map((it) => ({
      quantity: Number(it.cantidad),
      product: {
        description: it.concepto.slice(0, 100),
        product_key: "01010101",
        price: Number(it.precio_unitario),
        tax_included: true,
        taxes: [{ type: "IVA", rate: 0.16 }],
      },
    })),
    payment_form: "03",
    payment_method: "PUE",
    use: fiscal.uso_cfdi,
  };

  const res = await fetch("https://www.facturapi.io/v2/invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FACTURAPI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = await res.text();
    try {
      const j = JSON.parse(msg) as { message?: string; error?: string };
      msg = j.message || j.error || msg;
    } catch {
      /* keep text */
    }
    throw new FacturapiError(String(msg), res.status);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function downloadToBlobs(
  env: Env,
  facturapiId: string,
  ordenId: number,
): Promise<void> {
  const headers = { Authorization: `Bearer ${env.FACTURAPI_KEY}` };
  for (const kind of ["pdf", "xml"] as const) {
    const res = await fetch(
      `https://www.facturapi.io/v2/invoices/${facturapiId}/${kind}`,
      { headers },
    );
    const buf = await res.arrayBuffer();
    if (!res.ok || buf.byteLength === 0) {
      throw new FacturapiError(
        `${kind.toUpperCase()} inválido o vacío (status=${res.status})`,
        res.status,
      );
    }
    await putBlob(
      env,
      `factura_${ordenId}.${kind}`,
      buf,
      kind === "pdf" ? "application/pdf" : "application/xml",
    );
  }
}

export async function evaluarYTimbrar(
  env: Env,
  publicUrl: string,
  ordenId: number,
): Promise<Orden | null> {
  const row = await env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>();
  if (!row) return null;
  if (row.pago_estado !== "PAGADO") return row;
  if (!row.datos_fiscales_ok) return row;
  if (row.facturapi_id) return row;

  let fiscal: ClienteFiscal | null = null;
  if (row.cliente_fiscal_id) {
    fiscal = await env.DB.prepare("SELECT * FROM clientes_fiscales WHERE id = ?")
      .bind(row.cliente_fiscal_id)
      .first<ClienteFiscal>();
  }
  if (!fiscal) {
    fiscal = await env.DB.prepare(
      "SELECT * FROM clientes_fiscales WHERE telefono = ?",
    )
      .bind(row.telefono)
      .first<ClienteFiscal>();
  }
  if (!fiscal) {
    await env.DB.prepare(
      `UPDATE ordenes SET estado_chat = 'ERROR_FISCAL', error_fiscal = ?, updated_at = ? WHERE id = ?`,
    )
      .bind("No hay datos fiscales asociados a la orden.", nowIso(), ordenId)
      .run();
    return env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
      .bind(ordenId)
      .first<Orden>();
  }

  const items = JSON.parse(row.conceptos) as Item[];
  try {
    const invoice = await timbrarFacturapi(env, fiscal, items);
    const facturapiId = String(invoice.id || invoice._id || "");
    if (!facturapiId) throw new FacturapiError("Facturapi no devolvió id de factura");
    await downloadToBlobs(env, facturapiId, ordenId);
    await env.DB.prepare(
      `UPDATE ordenes SET facturapi_id = ?, estado_chat = 'COMPLETADO', error_fiscal = NULL, updated_at = ?
       WHERE id = ? AND facturapi_id IS NULL`,
    )
      .bind(facturapiId, nowIso(), ordenId)
      .run();
    await sendWhatsapp(
      env,
      row.telefono,
      `✅ Factura CFDI 4.0 timbrada (orden #${ordenId}).\nPDF: ${publicUrl}/files/factura_${ordenId}.pdf\nXML: ${publicUrl}/files/factura_${ordenId}.xml`,
    );
  } catch (err) {
    const message =
      err instanceof FacturapiError
        ? err.message
        : `Error al timbrar/descargar: ${String(err)}`;
    await env.DB.prepare(
      `UPDATE ordenes SET estado_chat = 'ERROR_FISCAL', error_fiscal = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(message.slice(0, 1000), nowIso(), ordenId)
      .run();
    await sendWhatsapp(
      env,
      row.telefono,
      err instanceof FacturapiError
        ? `⚠️ El pago de la orden #${ordenId} está confirmado, pero Facturapi rechazó los datos fiscales:\n${err.message}\n\nCorrige y reenvía:\nRFC | Razón Social | CP | Régimen | UsoCFDI\nNo se volverá a cobrar.`
        : `⚠️ Pago OK en orden #${ordenId}, pero falló el timbrado/descarga. Usa /admin → Reintentar timbrado.`,
    );
  }
  return env.DB.prepare("SELECT * FROM ordenes WHERE id = ?")
    .bind(ordenId)
    .first<Orden>();
}
