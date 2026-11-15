import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "../wasm/resvg.wasm";
import type { Item } from "../types";

const DEFAULT_VIGENCIA_MIN = 10;
const MONO = "IBM Plex Mono";

/** Ancho tipo papel térmico ~80 mm a resolución cómoda para WhatsApp. */
const WIDTH = 480;
const MARGIN = 28;
const CONTENT_W = WIDTH - MARGIN * 2;

let wasmReady: Promise<void> | null = null;
let fontCache: ArrayBuffer[] | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
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
    "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.5/latin-400-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.5/latin-500-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.5/latin-600-normal.ttf",
    "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.5/latin-700-normal.ttf",
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
  return `${t.slice(0, max - 1)}.`;
}

function dottedLine(y: number): string {
  return `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + CONTENT_W}" y2="${y}" stroke="#222" stroke-width="1.2" stroke-dasharray="2 3"/>`;
}

function solidLine(y: number): string {
  return `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + CONTENT_W}" y2="${y}" stroke="#111" stroke-width="1.6"/>`;
}

function serratedMask(height: number): string {
  const teeth = 24;
  const step = WIDTH / teeth;
  const depth = 9;
  const top: string[] = [`0,${depth}`];
  for (let i = 0; i < teeth; i++) {
    top.push(`${i * step + step / 2},0`);
    top.push(`${(i + 1) * step},${depth}`);
  }
  const bottom: string[] = [`${WIDTH},${height - depth}`];
  for (let i = teeth; i > 0; i--) {
    bottom.push(`${i * step - step / 2},${height}`);
    bottom.push(`${(i - 1) * step},${height - depth}`);
  }
  return `<polygon points="${[...top, ...bottom].join(" ")}" fill="#FFFEF8"/>`;
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
 * Ticket térmico de mostrador: papel angosto, mono, líneas punteadas, QR abajo.
 */
function buildTicketSvg(meta: TicketMeta, qrPngBase64: string): string {
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const now = new Date();
  const fecha = now.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const items =
    meta.items.length > 0
      ? meta.items.slice(0, 8)
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro CoDi",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];

  const cx = WIDTH / 2;
  const qrSize = 220;
  const body: string[] = [];
  let y = 36;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="22" font-weight="700" fill="#111">CoDiPey</text>`,
  );
  y += 22;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="#333">TICKET DE COBRO</text>`,
  );
  y += 18;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="#444">WhatsApp + CoDi  ·  $0 comisión</text>`,
  );
  y += 16;
  body.push(dottedLine(y));
  y += 22;

  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="12" fill="#222">Orden #${meta.ordenId}</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="12" fill="#222">${esc(fecha)}</text>`,
  );
  y += 18;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="11" fill="#444">Pago: CoDi Banxico</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11" fill="#444">Vig. ${vigencia} min</text>`,
  );
  y += 14;
  body.push(dottedLine(y));
  y += 24;

  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="11" font-weight="600" fill="#555">CANT  CONCEPTO</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11" font-weight="600" fill="#555">IMPORTE</text>`,
  );
  y += 10;
  body.push(dottedLine(y));
  y += 22;

  for (const it of items) {
    const cant = String(it.cantidad).padStart(2, " ");
    const name = truncate(it.concepto, 24);
    body.push(
      `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="13" fill="#111">${esc(cant)}  ${esc(name)}</text>`,
    );
    body.push(
      `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="13" fill="#111">$${esc(money(it.subtotal))}</text>`,
    );
    y += 18;
    body.push(
      `<text x="${MARGIN + 28}" y="${y}" font-family="${MONO}" font-size="11" fill="#666">${esc(String(it.cantidad))} x $${esc(money(it.precio_unitario))}</text>`,
    );
    y += 26;
  }

  body.push(dottedLine(y));
  y += 22;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="12" fill="#333">Comisión tarjeta</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="12" fill="#333">$0.00</text>`,
  );
  y += 16;
  body.push(solidLine(y));
  y += 7;
  body.push(solidLine(y));
  y += 26;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="18" font-weight="700" fill="#111">TOTAL</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="20" font-weight="700" fill="#111">$${esc(money(meta.monto))}</text>`,
  );
  y += 18;
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11" fill="#555">MXN</text>`,
  );
  y += 14;
  body.push(dottedLine(y));
  y += 24;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="12" font-weight="600" fill="#222">*** ESCANEA PARA PAGAR ***</text>`,
  );
  y += 12;

  const qrX = (WIDTH - qrSize) / 2;
  body.push(
    `<rect x="${qrX - 6}" y="${y}" width="${qrSize + 12}" height="${qrSize + 12}" fill="#FFFEF8" stroke="#111" stroke-width="1.5"/>`,
  );
  body.push(
    `<image href="data:image/png;base64,${qrPngBase64}" x="${qrX}" y="${y + 6}" width="${qrSize}" height="${qrSize}"/>`,
  );
  y += qrSize + 26;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="#333">QR CoDi - app de tu banco</text>`,
  );
  y += 16;
  if (meta.peyQrId) {
    body.push(
      `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="#555">Ref ${esc(truncate(String(meta.peyQrId), 20))}</text>`,
    );
    y += 16;
  }
  body.push(dottedLine(y));
  y += 22;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="#222">Gracias por su compra</text>`,
  );
  y += 16;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="#666">Conserve este ticket</text>`,
  );
  y += 28;

  const height = y;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  <rect width="${WIDTH}" height="${height}" fill="#E8E2D4"/>
  ${serratedMask(height)}
  ${body.join("\n  ")}
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

export async function renderTicketPng(
  qrPngBytes: ArrayBuffer,
  meta: TicketMeta,
): Promise<ArrayBuffer> {
  await ensureWasm();
  const fonts = await loadFonts();
  const svg = buildTicketSvg(meta, arrayBufferToBase64(qrPngBytes));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: {
      fontBuffers: fonts.map((f) => new Uint8Array(f)),
      defaultFontFamily: MONO,
    },
  });
  const png = resvg.render().asPng();
  return png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
}

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
    `🧾 *Ticket de cobro* · orden #${meta.ordenId}\n` +
    `${lines}\n` +
    `*TOTAL $${money(meta.monto)} MXN* · $0 comisión\n` +
    `Válido ${vigencia} min — escanea el QR del ticket.\n` +
    `Si no ves la imagen: ${mediaUrl}`
  );
}
