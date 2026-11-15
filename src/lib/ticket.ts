import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "../wasm/resvg.wasm";
import type { Item } from "../types";

const DEFAULT_VIGENCIA_MIN = 10;
const FONT_FAMILY = "Plus Jakarta Sans";

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
    "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@5.2.5/latin-600-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@5.2.5/latin-700-normal.ttf",
  ];
  const buffers = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Font HTTP ${res.status}`);
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
};

function buildTicketSvg(meta: TicketMeta, qrPngBase64: string): string {
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const items =
    meta.items.length > 0
      ? meta.items.slice(0, 6)
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro CoDi",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];

  const rowH = 36;
  const itemsBlock = items.length * rowH;
  const width = 720;
  const height = 210 + itemsBlock + 420 + 90;
  const qrSize = 340;
  const qrX = (width - qrSize) / 2;
  const qrY = 210 + itemsBlock + 36;

  const itemRows = items
    .map((it, i) => {
      const y = 188 + i * rowH;
      const label = truncate(`${it.cantidad} × ${it.concepto}`, 34);
      return `
        <text x="48" y="${y}" font-family="${FONT_FAMILY}" font-size="22" fill="#1A1814">${esc(label)}</text>
        <text x="672" y="${y}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="22" font-weight="700" fill="#16302B">$${esc(money(it.subtotal))}</text>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FBF8F1"/>
      <stop offset="100%" stop-color="#F3EEE3"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="20" fill="#FFFFFF" stroke="#D9D2C4" stroke-width="2"/>

  <text x="48" y="78" font-family="${FONT_FAMILY}" font-size="34" font-weight="700" fill="#16302B">CoDiPey</text>
  <text x="48" y="108" font-family="${FONT_FAMILY}" font-size="18" fill="#2F5C4F">Ticket de cobro · $0 comisión</text>

  <rect x="480" y="52" width="168" height="54" rx="14" fill="#F3E2B8"/>
  <text x="564" y="74" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="14" font-weight="700" fill="#8A6A1A">ORDEN</text>
  <text x="564" y="96" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="24" font-weight="700" fill="#16302B">#${meta.ordenId}</text>

  <line x1="48" y1="136" x2="672" y2="136" stroke="#E4DFD3" stroke-width="2" stroke-dasharray="8 8"/>

  <text x="48" y="168" font-family="${FONT_FAMILY}" font-size="14" font-weight="700" fill="#5E584F" letter-spacing="2">CONCEPTOS</text>
  ${itemRows}

  <line x1="48" y1="${188 + itemsBlock}" x2="672" y2="${188 + itemsBlock}" stroke="#E4DFD3" stroke-width="2"/>

  <text x="48" y="${228 + itemsBlock}" font-family="${FONT_FAMILY}" font-size="20" fill="#5E584F">Total a pagar</text>
  <text x="672" y="${228 + itemsBlock}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="40" font-weight="700" fill="#16302B">$${esc(money(meta.monto))}</text>
  <text x="672" y="${256 + itemsBlock}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="16" fill="#2F5C4F">MXN · CoDi</text>

  <rect x="${qrX - 16}" y="${qrY - 16}" width="${qrSize + 32}" height="${qrSize + 32}" rx="18" fill="#FCFBF8" stroke="#E4DFD3" stroke-width="2"/>
  <image href="data:image/png;base64,${qrPngBase64}" x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" />

  <text x="${width / 2}" y="${qrY + qrSize + 52}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="20" font-weight="700" fill="#16302B">Escanea con tu app bancaria</text>
  <text x="${width / 2}" y="${qrY + qrSize + 80}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" fill="#5E584F">Válido ${vigencia} min · Banxico CoDi</text>
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

/** Renderiza un ticket térmico con QR embebido. */
export async function renderTicketPng(
  qrPngBytes: ArrayBuffer,
  meta: TicketMeta,
): Promise<ArrayBuffer> {
  await ensureWasm();
  const fonts = await loadFonts();
  const svg = buildTicketSvg(meta, arrayBufferToBase64(qrPngBytes));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 720 },
    font: {
      fontBuffers: fonts.map((f) => new Uint8Array(f)),
      defaultFontFamily: FONT_FAMILY,
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
    `🧾 *Ticket CoDiPey* · orden #${meta.ordenId}\n` +
    `${lines}\n` +
    `*Total $${money(meta.monto)} MXN* · $0 de comisión\n` +
    `Válido ${vigencia} min — escanea el QR del ticket con tu banca.\n` +
    `Si no ves la imagen: ${mediaUrl}`
  );
}
