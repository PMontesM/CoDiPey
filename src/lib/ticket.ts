import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "../wasm/resvg.wasm";
import type { Item } from "../types";

const DEFAULT_VIGENCIA_MIN = 10;
const SANS = "Plus Jakarta Sans";
const SERIF = "Newsreader";
const MONO = "JetBrains Mono";

let wasmReady: Promise<void> | null = null;
let fontCache: ArrayBuffer[] | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    // Must use bundled CompiledWasm — Workers block WebAssembly.instantiate on fetched bytes.
    wasmReady = initWasm(resvgWasm).catch((err) => {
      wasmReady = null;
      throw err;
    });
  }
  return wasmReady;
}

async function loadFonts(): Promise<ArrayBuffer[]> {
  if (fontCache) return fontCache;
  const urls = [
    "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@5.2.5/latin-500-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@5.2.5/latin-600-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@5.2.5/latin-700-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/newsreader@5.2.6/latin-600-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@5.2.5/latin-500-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@5.2.5/latin-700-normal.ttf",
  ];
  const buffers = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Font HTTP ${res.status} ${url}`);
      return res.arrayBuffer();
    }),
  );
  fontCache = buffers;
  return buffers;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n: string | number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return v.toFixed(2);
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export type TicketMeta = {
  ordenId: number;
  monto: string;
  items: Item[];
  concepto?: string;
  vigenciaMin?: number;
  peyQrId?: string | null;
};

/**
 * Ticket al estilo del comprobante del panel (hoja blanca, serif editorial,
 * cajas anidadas, total en verde) + QR CoDi grande abajo.
 */
function buildTicketSvg(meta: TicketMeta, qrPngBase64: string): string {
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const items =
    meta.items.length > 0
      ? meta.items.slice(0, 5)
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro CoDi",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];

  const width = 680;
  const pad = 36;
  const cardX = pad;
  const cardW = width - pad * 2;
  const innerX = cardX + 28;
  const innerW = cardW - 56;

  const itemH = 28;
  const itemsH = items.length * itemH;
  const totalsH = 78;
  const conceptsBlockH = 18 + itemsH + 12 + totalsH;

  const qrSize = 280;
  const qrBoxPad = 18;
  const qrBoxH = qrSize + qrBoxPad * 2 + 52;

  // Layout Y positions inside white card
  const yRibbon = 56;
  const yTitle = 92;
  const yCards = 122;
  const cardBoxH = 72;
  const yConcepts = yCards + cardBoxH + 18;
  const yMeta = yConcepts + conceptsBlockH + 22;
  const metaH = 96;
  const yQr = yMeta + metaH + 18;
  const cardH = yQr + qrBoxH + 28;
  const height = pad + cardH + pad;

  const itemRows = items
    .map((it, i) => {
      const y = yConcepts + 22 + i * itemH;
      const label = truncate(`${it.cantidad}×  ${it.concepto}`, 36);
      return `
        <text x="${innerX}" y="${y}" font-family="${SANS}" font-size="15" font-weight="500" fill="#1C1917">${esc(label)}</text>
        <text x="${innerX + innerW}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="14" font-weight="500" fill="#1C1917">$${esc(money(it.subtotal))}</text>
      `;
    })
    .join("");

  const totalsY = yConcepts + 22 + itemsH + 18;
  const ref = meta.peyQrId
    ? truncate(String(meta.peyQrId), 22)
    : String(meta.ordenId);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#F7F4EC"/>
  <rect x="${cardX}" y="${pad}" width="${cardW}" height="${cardH}" rx="16" fill="#FFFFFF" stroke="#D8D1C2" stroke-width="1.5"/>

  <!-- Ribbon -->
  <circle cx="${innerX + 5}" cy="${yRibbon - 4}" r="4" fill="#15803D"/>
  <text x="${innerX + 16}" y="${yRibbon}" font-family="${SANS}" font-size="11" font-weight="700" fill="#15803D" letter-spacing="1.2">COMPROBANTE DE COBRO · CODI · $0 COMISIÓN</text>
  <rect x="${innerX + innerW - 108}" y="${yRibbon - 18}" width="108" height="24" rx="6" fill="#E8EFEC" stroke="rgba(22,48,43,0.2)" stroke-width="1"/>
  <text x="${innerX + innerW - 54}" y="${yRibbon - 2}" text-anchor="middle" font-family="${MONO}" font-size="11" font-weight="700" fill="#16302B">PENDIENTE</text>

  <!-- Title -->
  <text x="${innerX}" y="${yTitle}" font-family="${SERIF}" font-size="28" font-weight="600" fill="#1C1917">Ticket de cobro CoDiPey</text>

  <!-- Info cards row -->
  <rect x="${innerX}" y="${yCards}" width="${(innerW - 12) / 2}" height="${cardBoxH}" rx="10" fill="#FCFBF8" stroke="#E4DFD3" stroke-width="1"/>
  <text x="${innerX + 14}" y="${yCards + 22}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">ORDEN</text>
  <text x="${innerX + 14}" y="${yCards + 46}" font-family="${SANS}" font-size="18" font-weight="700" fill="#1C1917">#${meta.ordenId}</text>

  <rect x="${innerX + (innerW - 12) / 2 + 12}" y="${yCards}" width="${(innerW - 12) / 2}" height="${cardBoxH}" rx="10" fill="#FCFBF8" stroke="#E4DFD3" stroke-width="1"/>
  <text x="${innerX + (innerW - 12) / 2 + 26}" y="${yCards + 22}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">VIGENCIA QR</text>
  <text x="${innerX + (innerW - 12) / 2 + 26}" y="${yCards + 46}" font-family="${SANS}" font-size="18" font-weight="700" fill="#B45309">${vigencia} min</text>

  <!-- Concepts dashed block -->
  <line x1="${innerX}" y1="${yConcepts}" x2="${innerX + innerW}" y2="${yConcepts}" stroke="#D8D1C2" stroke-width="1.5" stroke-dasharray="5 5"/>
  ${itemRows}
  <line x1="${innerX}" y1="${totalsY - 10}" x2="${innerX + innerW}" y2="${totalsY - 10}" stroke="#E4DFD3" stroke-width="1"/>

  <text x="${innerX}" y="${totalsY + 8}" font-family="${MONO}" font-size="13" fill="#686158">Comisión CoDi</text>
  <text x="${innerX + innerW}" y="${totalsY + 8}" text-anchor="end" font-family="${MONO}" font-size="13" font-weight="700" fill="#15803D">$0.00</text>

  <text x="${innerX}" y="${totalsY + 36}" font-family="${SANS}" font-size="16" font-weight="700" fill="#1C1917">Total MXN</text>
  <text x="${innerX + innerW}" y="${totalsY + 36}" text-anchor="end" font-family="${SANS}" font-size="22" font-weight="700" fill="#15803D">$${esc(money(meta.monto))} MXN</text>

  <line x1="${innerX}" y1="${yConcepts + conceptsBlockH}" x2="${innerX + innerW}" y2="${yConcepts + conceptsBlockH}" stroke="#D8D1C2" stroke-width="1.5" stroke-dasharray="5 5"/>

  <!-- Payment metadata (panel-style grid) -->
  <text x="${innerX}" y="${yMeta + 14}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">FORMA DE PAGO</text>
  <text x="${innerX}" y="${yMeta + 34}" font-family="${SANS}" font-size="14" font-weight="600" fill="#1C1917">CoDi · Transferencia</text>

  <text x="${innerX + innerW / 2}" y="${yMeta + 14}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">MÉTODO</text>
  <text x="${innerX + innerW / 2}" y="${yMeta + 34}" font-family="${SANS}" font-size="14" font-weight="600" fill="#1C1917">Banxico · $0 comisión</text>

  <text x="${innerX}" y="${yMeta + 62}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">REFERENCIA PEY</text>
  <text x="${innerX}" y="${yMeta + 82}" font-family="${MONO}" font-size="13" font-weight="700" fill="#15803D">${esc(ref)}</text>

  <!-- QR box (folio-style footer) -->
  <rect x="${innerX}" y="${yQr}" width="${innerW}" height="${qrBoxH}" rx="12" fill="#F7F4EC" stroke="#E4DFD3" stroke-width="1"/>
  <text x="${innerX + 18}" y="${yQr + 24}" font-family="${MONO}" font-size="10" font-weight="700" fill="#686158" letter-spacing="1">QR CODI · ESCANEA CON TU APP BANCARIA</text>
  <image href="data:image/png;base64,${qrPngBase64}" x="${innerX + (innerW - qrSize) / 2}" y="${yQr + 38}" width="${qrSize}" height="${qrSize}" />
  <text x="${innerX + innerW / 2}" y="${yQr + qrBoxH - 14}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="#686158">Válido ${vigencia} min · Banxico CoDi</text>
</svg>`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Renderiza ticket estilo panel con QR embebido. */
export async function renderTicketPng(
  qrPngBytes: ArrayBuffer,
  meta: TicketMeta,
): Promise<ArrayBuffer> {
  await ensureWasm();
  const fonts = await loadFonts();
  const svg = buildTicketSvg(meta, arrayBufferToBase64(qrPngBytes));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 680 },
    font: {
      fontBuffers: fonts.map((f) => new Uint8Array(f)),
      defaultFontFamily: SANS,
    },
  });
  const png = resvg.render().asPng();
  return png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
}

/** Texto de ticket para el caption de WhatsApp. */
export function formatTicketCaption(
  meta: TicketMeta,
  mediaUrl: string,
): string {
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const items =
    meta.items.length > 0
      ? meta.items
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro CoDi",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];
  const lines = items
    .slice(0, 8)
    .map(
      (it) =>
        `• ${it.cantidad} × ${it.concepto} — $${money(it.subtotal)}`,
    )
    .join("\n");
  return (
    `🧾 *Ticket de cobro CoDiPey* · orden #${meta.ordenId}\n` +
    `${lines}\n` +
    `*Total $${money(meta.monto)} MXN* · $0 de comisión\n` +
    `Válido ${vigencia} min — escanea el QR del ticket con tu banca.\n` +
    `Si no ves la imagen: ${mediaUrl}`
  );
}
