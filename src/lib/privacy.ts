/**
 * Enmascara teléfonos en respuestas del panel (panel abierto / demo).
 * Ejemplo: whatsapp:+52172227110104 → +52••••••••0104
 */
export function maskWhatsappPhone(raw: string | null | undefined): string {
  const original = String(raw || "").trim();
  if (!original) return "••••";
  const s = original.replace(/^whatsapp:/i, "");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "••••";
  const last4 = digits.slice(-4);
  if (digits.length <= 4) return `••••${last4}`;

  // Conserva + y código de país corto (MX 52, US 1, etc.).
  let ccLen = 0;
  if (s.startsWith("+")) {
    if (digits.startsWith("52") && digits.length >= 12) ccLen = 2;
    else if (digits.startsWith("1") && digits.length >= 11) ccLen = 1;
    else ccLen = Math.min(3, Math.max(1, digits.length - 10));
  }
  const cc = ccLen ? digits.slice(0, ccLen) : "";
  const midLen = Math.max(4, digits.length - ccLen - 4);
  const masked = `${cc ? `+${cc}` : ""}${"•".repeat(midLen)}${last4}`;
  return masked;
}

/** Enmascara números largos dentro de textos (p. ej. contexto del error log). */
export function maskPhonesInText(text: string | null | undefined): string {
  const s = String(text || "");
  if (!s) return s;
  return s.replace(/(?:whatsapp:)?\+?\d{10,16}/gi, (m) => maskWhatsappPhone(m));
}

/** Copia de orden para JSON de operador: sin teléfono completo. */
export function maskOrdenForApi<T extends { telefono?: string | null }>(
  orden: T,
): T {
  return {
    ...orden,
    telefono: maskWhatsappPhone(orden.telefono),
  };
}
