/** Preview helper mirroring src/lib/ticket.ts thermal layout (no wasm import). */
const MONO = "IBM Plex Mono";
const WIDTH = 480;
const MARGIN = 28;
const CONTENT_W = WIDTH - MARGIN * 2;

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : String(n);
}
function truncate(s, max) {
  const t = String(s).trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}.`;
}
function dottedLine(y) {
  return `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + CONTENT_W}" y2="${y}" stroke="#222" stroke-width="1.2" stroke-dasharray="2 3"/>`;
}
function solidLine(y) {
  return `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + CONTENT_W}" y2="${y}" stroke="#111" stroke-width="1.6"/>`;
}
function serratedMask(height) {
  const teeth = 24;
  const step = WIDTH / teeth;
  const depth = 9;
  const top = [`0,${depth}`];
  for (let i = 0; i < teeth; i++) {
    top.push(`${i * step + step / 2},0`);
    top.push(`${(i + 1) * step},${depth}`);
  }
  const bottom = [`${WIDTH},${height - depth}`];
  for (let i = teeth; i > 0; i--) {
    bottom.push(`${i * step - step / 2},${height}`);
    bottom.push(`${(i - 1) * step},${height - depth}`);
  }
  return `<polygon points="${[...top, ...bottom].join(" ")}" fill="#FFFEF8"/>`;
}

export function buildForPreview(qrPngBase64, meta) {
  const vigencia = meta.vigenciaMin ?? 10;
  const fecha = new Date().toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const items = meta.items?.length
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
  const body = [];
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
    body.push(
      `<text x="${MARGIN}" y="${y}" font-family="${MONO}" font-size="13" fill="#111">${esc(cant)}  ${esc(truncate(it.concepto, 24))}</text>`,
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
