import type { Item } from "../types";

const PRODUCT_LINE_RE =
  /^\s*(\d+(?:[.,]\d+)?)\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*$/;

function toNum(raw: string): number {
  return Number(raw.replace(",", "."));
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function parseProductLines(
  text: string,
): { items: Item[] | null; error: string | null } {
  // Varios productos: una por línea, o separados por ; / ,
  const rawChunks = text
    .trim()
    .split(/\r?\n|;/)
    .flatMap((chunk) => {
      const t = chunk.trim();
      if (!t) return [];
      // "2 Cafe 45, 1 Agua 10" → partir por coma si cada lado parece producto
      if (t.includes(",")) {
        const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length > 1 && parts.every((p) => PRODUCT_LINE_RE.test(p))) {
          return parts;
        }
      }
      return [t];
    });

  if (!rawChunks.length) {
    return {
      items: null,
      error:
        "Envía productos, uno por línea. Ejemplo:\n2 Cafe 45\n1 Agua 10\n1 Prueba Mostrito 0.01",
    };
  }
  const items: Item[] = [];
  for (const ln of rawChunks) {
    const m = PRODUCT_LINE_RE.exec(ln);
    if (!m) {
      return {
        items: null,
        error: `No entendí: «${ln}»\nFormato: <cantidad> <concepto> <precio>\nVarios: una línea cada uno\nEjemplo:\n2 Cafe 45\n1 Agua 10`,
      };
    }
    const qty = toNum(m[1]);
    const price = toNum(m[3]);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) {
      return { items: null, error: `Cantidad o precio inválido en: «${ln}»` };
    }
    if (qty <= 0 || price <= 0) {
      return {
        items: null,
        error: `Cantidad y precio deben ser mayores a 0. Revisé: «${ln}»`,
      };
    }
    items.push({
      cantidad: String(qty),
      concepto: m[2].trim(),
      precio_unitario: String(price),
      subtotal: money(qty * price),
    });
  }
  return { items, error: null };
}

export function sumItems(items: Item[]): string {
  const total = items.reduce((acc, i) => acc + Number(i.subtotal), 0);
  return money(total);
}

export function conceptForPey(items: Item[], ordenId: number): string {
  const names = items.map((i) => i.concepto).join(", ");
  return `Orden ${ordenId}: ${names}`.slice(0, 40);
}

export function parseFiscalData(
  text: string,
): { data: Record<string, string> | null; error: string | null } {
  const parts = text.split("|").map((p) => p.trim());
  if (parts.length !== 5) {
    return {
      data: null,
      error:
        "Datos incompletos. Envía exactamente:\nRFC | Razón Social | CP | Régimen | UsoCFDI\nEjemplo: XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03",
    };
  }
  const [rfc, razon, cp, regimen, uso] = parts;
  if (![rfc, razon, cp, regimen, uso].every(Boolean)) {
    return {
      data: null,
      error:
        "Todos los campos fiscales son obligatorios (RFC | Razón Social | CP | Régimen | UsoCFDI).",
    };
  }
  if (cp.length !== 5 || !/^\d+$/.test(cp)) {
    return { data: null, error: "El código postal debe ser de 5 dígitos." };
  }
  return {
    data: {
      rfc: rfc.toUpperCase(),
      razon_social: razon,
      codigo_postal: cp,
      regimen,
      uso_cfdi: uso.toUpperCase(),
    },
    error: null,
  };
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function nowIso(): string {
  return new Date().toISOString();
}
