import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "../wasm/resvg.wasm";
import type { Item } from "../types";

const DEFAULT_VIGENCIA_MIN = 10;
const MONO = "IBM Plex Mono";

/** Ancho tipo papel térmico, a buena resolución para celular (WhatsApp comprime). */
const WIDTH = 720;
const MARGIN = 40;
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
            concepto: meta.concepto || "Cobro Mostrito",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];

  const cx = WIDTH / 2;
  const qrSize = 360;
  const body: string[] = [];
  let y = 48;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="34" font-weight="700" fill="#111">Mostrito</text>`,
  );
  y += 30;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="#333">TICKET DE COBRO</text>`,
  );
  y += 24;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="14" fill="#444">WhatsApp + QR  ·  $0 comisión</text>`,
  );
  y += 20;
  body.push(dottedLine(y));
  y += 28;

  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="16" fill="#222">Orden #${meta.ordenId}</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="15" fill="#222">${esc(fecha)}</text>`,
  );
  y += 24;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="14" fill="#444">Pago: app de tu banco</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="14" fill="#444">Vig. ${vigencia} min</text>`,
  );
  y += 18;
  body.push(dottedLine(y));
  y += 30;

  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="13" font-weight="600" fill="#555">CANT  CONCEPTO</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="13" font-weight="600" fill="#555">IMPORTE</text>`,
  );
  y += 12;
  body.push(dottedLine(y));
  y += 28;

  for (const it of items) {
    const cant = String(it.cantidad).padStart(2, " ");
    const name = truncate(it.concepto, 28);
    body.push(
      `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="18" fill="#111">${esc(cant)}  ${esc(name)}</text>`,
    );
    body.push(
      `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="18" fill="#111">$${esc(money(it.subtotal))}</text>`,
    );
    y += 24;
    body.push(
      `<text x="${MARGIN + 36}" y="${y}" font-family="${MONO}" font-size="14" fill="#666">${esc(String(it.cantidad))} x $${esc(money(it.precio_unitario))}</text>`,
    );
    y += 32;
  }

  body.push(dottedLine(y));
  y += 28;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="16" fill="#333">Comisión tarjeta</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="16" fill="#333">$0.00</text>`,
  );
  y += 20;
  body.push(solidLine(y));
  y += 8;
  body.push(solidLine(y));
  y += 34;
  body.push(
    `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="26" font-weight="700" fill="#111">TOTAL</text>`,
  );
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="30" font-weight="700" fill="#111">$${esc(money(meta.monto))}</text>`,
  );
  y += 24;
  body.push(
    `<text x="${MARGIN + CONTENT_W}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="14" fill="#555">MXN</text>`,
  );
  y += 18;
  body.push(dottedLine(y));
  y += 30;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="16" font-weight="700" fill="#222">*** ESCANEA PARA PAGAR ***</text>`,
  );
  y += 16;

  const qrX = (WIDTH - qrSize) / 2;
  body.push(
    `<rect x="${qrX - 10}" y="${y}" width="${qrSize + 20}" height="${qrSize + 20}" fill="#FFFEF8" stroke="#111" stroke-width="2"/>`,
  );
  body.push(
    `<image href="data:image/png;base64,${qrPngBase64}" x="${qrX}" y="${y + 10}" width="${qrSize}" height="${qrSize}"/>`,
  );
  y += qrSize + 36;

  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="14" fill="#333">QR · app de tu banco</text>`,
  );
  y += 20;
  if (meta.peyQrId) {
    body.push(
      `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="13" fill="#555">Ref ${esc(truncate(String(meta.peyQrId), 24))}</text>`,
    );
    y += 20;
  }
  body.push(dottedLine(y));
  y += 28;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="15" fill="#222">Gracias por su compra</text>`,
  );
  y += 20;
  body.push(
    `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="#666">Conserve este ticket</text>`,
  );
  y += 36;

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
  opts: { mediaUrl: string; ticketUrl: string; paymentUrl?: string | null },
): string {
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const items =
    meta.items.length > 0
      ? meta.items
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro Mostrito",
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
  // Link de pago de pey: solo si la API lo devolvió. El cliente que compra
  // por WhatsApp no puede escanear su propia pantalla; con el link paga
  // tocándolo, sin cámara.
  const payLink = opts.paymentUrl
    ? `\n\n💳 *O paga tocando el link (sin escanear):*\n${opts.paymentUrl}`
    : "";
  return (
    `🧾 *Ticket de cobro* · orden #${meta.ordenId}\n` +
    `${lines}\n` +
    `*TOTAL $${money(meta.monto)} MXN* · $0 comisión\n` +
    `Válido ${vigencia} min.\n\n` +
    `📱 *Ábrelo a pantalla completa (más fácil de escanear):*\n${opts.ticketUrl}` +
    payLink
  );
}

export type TicketPageOpts = {
  meta: TicketMeta;
  qrImageUrl: string;
  estado: "PENDIENTE" | "PAGADO" | "CANCELADO" | "VENCIDO";
  expiresInSec?: number;
  paymentUrl?: string | null;
};

/** HTML responsive: WhatsApp no renderiza HTML; se abre en el navegador del celular. */
export function renderTicketHtmlPage(opts: TicketPageOpts): string {
  const { meta, qrImageUrl, estado, paymentUrl } = opts;
  const vigencia = meta.vigenciaMin ?? DEFAULT_VIGENCIA_MIN;
  const items =
    meta.items.length > 0
      ? meta.items
      : [
          {
            cantidad: "1",
            concepto: meta.concepto || "Cobro Mostrito",
            precio_unitario: meta.monto,
            subtotal: meta.monto,
          },
        ];
  const itemRows = items
    .map(
      (it) => `
      <div class="row">
        <div>
          <div class="name">${esc(String(it.cantidad))} × ${esc(it.concepto)}</div>
          <div class="unit">${esc(String(it.cantidad))} x $${esc(money(it.precio_unitario))}</div>
        </div>
        <div class="amt">$${esc(money(it.subtotal))}</div>
      </div>`,
    )
    .join("");

  const statusLabel =
    estado === "PAGADO"
      ? "PAGADO"
      : estado === "CANCELADO"
        ? "CANCELADO"
        : estado === "VENCIDO"
          ? "QR VENCIDO"
          : "POR PAGAR";
  const statusClass =
    estado === "PAGADO"
      ? "ok"
      : estado === "PENDIENTE"
        ? "wait"
        : "bad";

  const showQr = estado === "PENDIENTE";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#FFFEF8" />
  <title>Ticket #${meta.ordenId} · Mostrito</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      background: #E8E2D4;
      color: #111;
      min-height: 100dvh;
      padding: 12px;
      padding-bottom: max(20px, env(safe-area-inset-bottom));
    }
    .paper {
      max-width: 420px;
      margin: 0 auto;
      background: #FFFEF8;
      border: 1.5px solid #222;
      padding: 1.1rem 1rem 1.35rem;
      box-shadow: 0 10px 28px rgba(0,0,0,0.08);
    }
    .brand { text-align: center; font-weight: 700; font-size: 1.45rem; letter-spacing: -0.02em; }
    .sub { text-align: center; font-size: 0.78rem; color: #444; margin-top: 0.25rem; }
    .dots { border-top: 1.5px dashed #333; margin: 0.85rem 0; }
    .meta { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.82rem; margin: 0.35rem 0; }
    .status {
      display: inline-block; margin: 0.5rem auto 0; padding: 0.35rem 0.65rem;
      border: 1.5px solid #111; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em;
    }
    .status.ok { background: #DCFCE7; border-color: #15803D; color: #14532D; }
    .status.wait { background: #FEF3C7; border-color: #B45309; color: #92400E; }
    .status.bad { background: #FFE4E6; border-color: #9F1239; color: #9F1239; }
    .center { text-align: center; }
    .row { display: flex; justify-content: space-between; gap: 0.75rem; padding: 0.45rem 0; font-size: 0.95rem; }
    .name { font-weight: 600; line-height: 1.25; }
    .unit { font-size: 0.75rem; color: #666; margin-top: 0.15rem; }
    .amt { font-weight: 600; white-space: nowrap; }
    .total {
      display: flex; justify-content: space-between; align-items: baseline;
      font-weight: 700; font-size: 1.45rem; margin-top: 0.35rem;
    }
    .total small { display: block; text-align: right; font-size: 0.7rem; font-weight: 500; color: #555; }
    .scan { text-align: center; font-weight: 700; font-size: 0.85rem; margin: 0.85rem 0 0.65rem; }
    .qr-wrap {
      width: min(78vw, 300px); margin: 0 auto; padding: 0.55rem;
      border: 2px solid #111; background: #fff;
    }
    .qr-wrap img { width: 100%; height: auto; display: block; image-rendering: pixelated; }
    .foot { text-align: center; font-size: 0.78rem; color: #444; margin-top: 0.85rem; line-height: 1.4; }
    .paybtn { display: block; text-align: center; margin: 0.9rem auto 0; padding: 0.75rem 0.5rem; border: 2px solid #111; background: #111; color: #FFFEF8; font-weight: 700; font-size: 0.95rem; text-decoration: none; }
    .hint { text-align: center; font-size: 0.72rem; color: #666; margin-top: 1rem; }
  </style>
</head>
<body>
  <article class="paper">
    <div class="brand">Mostrito</div>
    <div class="sub">TICKET DE COBRO</div>
    <div class="sub">WhatsApp + QR · $0 comisión</div>
    <div class="center"><span class="status ${statusClass}">${statusLabel}</span></div>
    <div class="dots"></div>
    <div class="meta"><span>Orden #${meta.ordenId}</span><span>Vig. ${vigencia} min</span></div>
    <div class="meta"><span>Pago: app de tu banco</span><span>$${esc(money(meta.monto))} MXN</span></div>
    <div class="dots"></div>
    ${itemRows}
    <div class="row"><div class="name" style="font-weight:500;color:#444">Comisión tarjeta</div><div class="amt">$0.00</div></div>
    <div class="dots"></div>
    <div class="total"><span>TOTAL</span><div>$${esc(money(meta.monto))}<small>MXN</small></div></div>
    ${
      showQr
        ? `<div class="dots"></div>
    <p class="scan">*** ESCANEA PARA PAGAR ***</p>
    <div class="qr-wrap"><img src="${esc(qrImageUrl)}" alt="QR de pago orden ${meta.ordenId}" width="600" height="600" /></div>
    <p class="foot">QR · app de tu banco${meta.peyQrId ? `<br/>Ref ${esc(truncate(String(meta.peyQrId), 24))}` : ""}</p>${
            paymentUrl
              ? `<a class="paybtn" href="${esc(paymentUrl)}">Pagar sin escanear</a>`
              : ""
          }`
        : `<div class="dots"></div><p class="foot">${
            estado === "PAGADO"
              ? "Este cobro ya fue liquidado."
              : estado === "VENCIDO"
                ? "El QR venció. Pide un Nuevo QR por WhatsApp."
                : "Este cobro fue cancelado."
          }</p>`
    }
    <div class="dots"></div>
    <p class="foot">Gracias por su compra<br/>Conserve este ticket</p>
  </article>
  <p class="hint">Ábrelo desde WhatsApp · se adapta a tu pantalla</p>
</body>
</html>`;
}
