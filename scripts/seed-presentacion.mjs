#!/usr/bin/env node
/**
 * Borra ordenes/fiscales/blobs/demo_whatsapp y planta escenarios de presentación.
 *
 * Uso:
 *   node scripts/seed-presentacion.mjs --remote
 *   node scripts/seed-presentacion.mjs --local
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remote = process.argv.includes("--remote");
const local = process.argv.includes("--local");
if (!remote && !local) {
  console.error("Indica --remote o --local");
  process.exit(1);
}

const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** PNG 1×1 transparente (placeholder de QR / ticket). */
const PNG_HEX =
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000000300010005fed2ef0000000049454e44ae426082";

function items(...rows) {
  return JSON.stringify(
    rows.map(([cantidad, concepto, precio]) => {
      const precio_unitario = Number(precio).toFixed(2);
      const subtotal = (Number(cantidad) * Number(precio)).toFixed(2);
      return {
        cantidad: String(cantidad),
        concepto,
        precio_unitario,
        subtotal,
      };
    }),
  );
}

const DEMO_WA = "whatsapp:+5215500000099";
const WA = {
  maria: "whatsapp:+5215510076571",
  carlos: "whatsapp:+5215548192034",
  laura: "whatsapp:+5215583920145",
  diego: "whatsapp:+5215529018473",
  sofia: "whatsapp:+5215533445566",
  pedro: "whatsapp:+5215577889900",
};

const fiscales = [
  {
    telefono: DEMO_WA,
    rfc: "URE180429TM6",
    razon_social: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
    codigo_postal: "86991",
    regimen: "601",
    uso_cfdi: "G03",
  },
  {
    telefono: WA.maria,
    rfc: "URE180429TM6",
    razon_social: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
    codigo_postal: "86991",
    regimen: "601",
    uso_cfdi: "G03",
  },
  {
    telefono: WA.carlos,
    rfc: "XAXX010101000",
    razon_social: "PUBLICO EN GENERAL",
    codigo_postal: "06600",
    regimen: "616",
    uso_cfdi: "S01",
  },
  {
    telefono: WA.laura,
    rfc: "URE180429TM6",
    razon_social: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
    codigo_postal: "06600",
    regimen: "601",
    uso_cfdi: "G03",
  },
];

/**
 * Escenarios pensados para el panel en pitch (ORDER BY id DESC = más reciente primero).
 * Insert order = id order.
 */
const ordenes = [
  // 1 — Completado + CFDI (historia feliz)
  {
    telefono: WA.carlos,
    conceptos: items([2, "Café de especialidad", 65], [1, "Pan artesanal", 55]),
    monto: "185.00",
    concepto_pey: "Café + pan · CFDI",
    pago_estado: "PAGADO",
    requiere_factura: 1,
    datos_fiscales_ok: 1,
    facturapi_id: "inv_seed_cafe_pan",
    cfdi_uuid: "8D3A19F0-4C2B-4E91-9A08-7B12E4C901DF",
    pey_transaction_id: "seed_tx_cafe_pan",
    pey_qr_id: "seed_qr_cafe_pan",
    estado_chat: "COMPLETADO",
    error_fiscal: null,
    fiscalTel: WA.carlos,
    created_at: iso(95),
    updated_at: iso(90),
  },
  // 2 — Pagado sin factura (Sin RFC)
  {
    telefono: WA.diego,
    conceptos: items([3, "Agua embotellada", 10], [2, "Galletas", 18]),
    monto: "66.00",
    concepto_pey: "Agua + galletas · sin factura",
    pago_estado: "PAGADO",
    requiere_factura: 0,
    datos_fiscales_ok: 0,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: "seed_tx_sin_rfc",
    pey_qr_id: "seed_qr_sin_rfc",
    estado_chat: "COMPLETADO",
    error_fiscal: null,
    fiscalTel: null,
    created_at: iso(80),
    updated_at: iso(75),
  },
  // 3 — Venta grande timbrada (KPI $0 comisión / ahorros)
  {
    telefono: WA.maria,
    conceptos: items(
      [12, "Huevo blanco carton", 48],
      [6, "Leche entera 1L", 28],
      [4, "Aceite vegetal 1L", 42],
      [8, "Pan de caja", 38],
    ),
    monto: "1016.00",
    concepto_pey: "Surtido abarrotes · CFDI",
    pago_estado: "PAGADO",
    requiere_factura: 1,
    datos_fiscales_ok: 1,
    facturapi_id: "inv_seed_abarrotes",
    cfdi_uuid: "A1B2C3D4-E5F6-4789-A012-3456789ABCDE",
    pey_transaction_id: "seed_tx_abarrotes",
    pey_qr_id: "seed_qr_abarrotes",
    estado_chat: "COMPLETADO",
    error_fiscal: null,
    fiscalTel: WA.maria,
    created_at: iso(70),
    updated_at: iso(65),
  },
  // 4 — Cancelado
  {
    telefono: WA.pedro,
    conceptos: items([1, "Prueba CoDi", 0.01]),
    monto: "0.01",
    concepto_pey: "Prueba cancelada",
    pago_estado: "CANCELADO",
    requiere_factura: 0,
    datos_fiscales_ok: 0,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: null,
    pey_qr_id: null,
    estado_chat: "CANCELADO",
    error_fiscal: null,
    fiscalTel: null,
    created_at: iso(55),
    updated_at: iso(50),
  },
  // 5 — Pagado + error fiscal (mostrar Reintentar timbrado)
  {
    telefono: WA.laura,
    conceptos: items(
      [2, "Servicio de soporte", 500],
      [1, "Configuración de red", 850],
    ),
    monto: "1850.00",
    concepto_pey: "Soporte · error fiscal",
    pago_estado: "PAGADO",
    requiere_factura: 1,
    datos_fiscales_ok: 1,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: "seed_tx_error_fiscal",
    pey_qr_id: "seed_qr_error_fiscal",
    estado_chat: "ERROR_FISCAL",
    error_fiscal:
      "CFDI40147: El campo DomicilioFiscalReceptor (06600) no coincide con el código postal registrado ante el SAT para el RFC URE180429TM6.",
    fiscalTel: WA.laura,
    created_at: iso(40),
    updated_at: iso(38),
  },
  // 6 — Esperando datos fiscales (wizard)
  {
    telefono: WA.sofia,
    conceptos: items([1, "Café americano", 45], [1, "Agua embotellada", 10]),
    monto: "55.00",
    concepto_pey: "Café · esperando RFC",
    pago_estado: "PENDIENTE",
    requiere_factura: 1,
    datos_fiscales_ok: 0,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: null,
    pey_qr_id: null,
    estado_chat: "ESPERANDO_FISCAL_RFC",
    error_fiscal: null,
    fiscalTel: null,
    created_at: iso(25),
    updated_at: iso(24),
  },
  // 7 — Carrito ARMAR_PEDIDO
  {
    telefono: WA.pedro,
    conceptos: items([2, "Café americano", 45], [3, "Agua embotellada", 10]),
    monto: "120.00",
    concepto_pey: "Carrito en curso",
    pago_estado: "PENDIENTE",
    requiere_factura: 0,
    datos_fiscales_ok: 0,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: null,
    pey_qr_id: null,
    estado_chat: "ARMAR_PEDIDO",
    error_fiscal: null,
    fiscalTel: null,
    created_at: iso(12),
    updated_at: iso(8),
  },
  // 8 — Pendiente con QR fresco → listo para «Simular Webhook Pago pey»
  {
    telefono: DEMO_WA,
    conceptos: items([1, "Demo CoDiPey abarrotes", 25]),
    monto: "25.00",
    concepto_pey: "Demo CoDiPey · listo para liquidar",
    pago_estado: "PENDIENTE",
    requiere_factura: 1,
    datos_fiscales_ok: 1,
    facturapi_id: null,
    cfdi_uuid: null,
    pey_transaction_id: null,
    pey_qr_id: "seed_qr_pendiente_demo",
    estado_chat: "ESPERANDO_PAGO",
    error_fiscal: null,
    fiscalTel: DEMO_WA,
    created_at: iso(3),
    updated_at: iso(2),
    withQrBlob: true,
  },
];

const lines = [
  "-- Seed presentación CoDiPey (generado por scripts/seed-presentacion.mjs)",
  "PRAGMA foreign_keys = OFF;",
  "DELETE FROM blobs;",
  "DELETE FROM ordenes;",
  "DELETE FROM clientes_fiscales;",
  "DELETE FROM demo_whatsapp;",
  "DELETE FROM sqlite_sequence WHERE name IN ('ordenes', 'clientes_fiscales', 'demo_whatsapp');",
  "",
];

for (const f of fiscales) {
  lines.push(
    `INSERT INTO clientes_fiscales (telefono, rfc, razon_social, codigo_postal, regimen, uso_cfdi, updated_at) VALUES (${[
      sqlStr(f.telefono),
      sqlStr(f.rfc),
      sqlStr(f.razon_social),
      sqlStr(f.codigo_postal),
      sqlStr(f.regimen),
      sqlStr(f.uso_cfdi),
      sqlStr(iso(100)),
    ].join(", ")});`,
  );
}

lines.push("");

ordenes.forEach((o, idx) => {
  const id = idx + 1;
  const fiscalSub = o.fiscalTel
    ? `(SELECT id FROM clientes_fiscales WHERE telefono = ${sqlStr(o.fiscalTel)})`
    : "NULL";
  lines.push(
    `INSERT INTO ordenes (
      telefono, conceptos, monto, concepto_pey, pago_estado,
      requiere_factura, datos_fiscales_ok, facturapi_id, cfdi_uuid,
      pey_transaction_id, pey_qr_id, estado_chat, error_fiscal,
      cliente_fiscal_id, created_at, updated_at
    ) VALUES (
      ${sqlStr(o.telefono)},
      ${sqlStr(o.conceptos)},
      ${sqlStr(o.monto)},
      ${sqlStr(o.concepto_pey)},
      ${sqlStr(o.pago_estado)},
      ${o.requiere_factura},
      ${o.datos_fiscales_ok},
      ${o.facturapi_id == null ? "NULL" : sqlStr(o.facturapi_id)},
      ${o.cfdi_uuid == null ? "NULL" : sqlStr(o.cfdi_uuid)},
      ${o.pey_transaction_id == null ? "NULL" : sqlStr(o.pey_transaction_id)},
      ${o.pey_qr_id == null ? "NULL" : sqlStr(o.pey_qr_id)},
      ${sqlStr(o.estado_chat)},
      ${o.error_fiscal == null ? "NULL" : sqlStr(o.error_fiscal)},
      ${fiscalSub},
      ${sqlStr(o.created_at)},
      ${sqlStr(o.updated_at)}
    );`,
  );

  if (o.withQrBlob) {
    const ts = sqlStr(o.updated_at);
    lines.push(
      `INSERT INTO blobs (key, content_type, data, updated_at) VALUES (${sqlStr(`qr_${id}.png`)}, 'image/png', X'${PNG_HEX}', ${ts});`,
      `INSERT INTO blobs (key, content_type, data, updated_at) VALUES (${sqlStr(`qr_code_${id}.png`)}, 'image/png', X'${PNG_HEX}', ${ts});`,
    );
  }
});

lines.push(
  "",
  `INSERT INTO demo_whatsapp (telefono, e164, created_at, sms_enviado, sms_error) VALUES ('5510076571', '+525510076571', ${sqlStr(iso(20))}, 1, NULL);`,
  "PRAGMA foreign_keys = ON;",
);

const dir = mkdtempSync(join(tmpdir(), "codipey-seed-"));
const file = join(dir, "seed-presentacion.sql");
writeFileSync(file, lines.join("\n") + "\n", "utf8");

const args = ["wrangler", "d1", "execute", "cobro-db", "--file", file, "--yes"];
if (remote) args.push("--remote");
if (local) args.push("--local");

console.log(`Aplicando seed ${remote ? "remoto" : "local"} (${ordenes.length} órdenes)…`);
try {
  execFileSync("npx", args, { stdio: "inherit", cwd: process.cwd() });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Listo. Escenarios:");
ordenes.forEach((o, i) => {
  console.log(`  #${i + 1}  ${o.pago_estado.padEnd(10)} ${o.estado_chat.padEnd(22)} $${o.monto}  ${o.concepto_pey}`);
});
