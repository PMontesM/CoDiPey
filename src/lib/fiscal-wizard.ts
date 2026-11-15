import type { Env } from "../types";
import { getBlob, putBlob } from "./blobs";

export type FiscalDraft = {
  rfc?: string;
  razon_social?: string;
  codigo_postal?: string;
  regimen?: string;
  uso_cfdi?: string;
};

export const FISCAL_STEPS = [
  "ESPERANDO_FISCAL_RFC",
  "ESPERANDO_FISCAL_NOMBRE",
  "ESPERANDO_FISCAL_CP",
  "ESPERANDO_FISCAL_REGIMEN",
  "ESPERANDO_FISCAL_USO",
] as const;

export type FiscalStep = (typeof FISCAL_STEPS)[number];

export function isFiscalWizardState(estado: string): boolean {
  return (FISCAL_STEPS as readonly string[]).includes(estado);
}

/** Regímenes frecuentes en retail / persona física (etiqueta clara + código SAT). */
export const REGIMEN_OPTIONS = [
  {
    id: "REG_626",
    item: "RESICO (fácil)",
    description: "626 · Régimen Simplificado de Confianza",
    code: "626",
  },
  {
    id: "REG_612",
    item: "Actividad empresarial",
    description: "612 · Persona física con actividad",
    code: "612",
  },
  {
    id: "REG_601",
    item: "Empresa / SA / SRL",
    description: "601 · Persona moral",
    code: "601",
  },
  {
    id: "REG_603",
    item: "Asociación / donataria",
    description: "603 · Sin fines de lucro",
    code: "603",
  },
  {
    id: "REG_616",
    item: "Sin obligaciones",
    description: "616 · Como público en general",
    code: "616",
  },
];

/** Usos de CFDI más comunes al comprar en tienda. */
export const USO_OPTIONS = [
  {
    id: "USO_G03",
    item: "Gastos en general",
    description: "G03 · Lo más común",
    code: "G03",
  },
  {
    id: "USO_G01",
    item: "Mercancías / reventa",
    description: "G01 · Adquisición de mercancías",
    code: "G01",
  },
  {
    id: "USO_S01",
    item: "Sin efectos fiscales",
    description: "S01 · Cuando el SAT no aplica uso",
    code: "S01",
  },
  {
    id: "USO_CP01",
    item: "Pagos",
    description: "CP01 · Complemento de pagos",
    code: "CP01",
  },
];

function draftKey(telefono: string): string {
  return `fiscal_draft:${telefono}`;
}

export async function loadFiscalDraft(
  env: Env,
  telefono: string,
): Promise<FiscalDraft> {
  const blob = await getBlob(env, draftKey(telefono));
  if (!blob) return {};
  try {
    const text = new TextDecoder().decode(blob.data);
    return JSON.parse(text) as FiscalDraft;
  } catch {
    return {};
  }
}

export async function saveFiscalDraft(
  env: Env,
  telefono: string,
  draft: FiscalDraft,
): Promise<void> {
  const u8 = new TextEncoder().encode(JSON.stringify(draft));
  const buf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  await putBlob(env, draftKey(telefono), buf, "application/json");
}

export async function clearFiscalDraft(
  env: Env,
  telefono: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM blobs WHERE key = ?")
    .bind(draftKey(telefono))
    .run();
}

export function normalizeRfc(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function validateRfc(raw: string): string | null {
  const rfc = normalizeRfc(raw);
  if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) {
    return "Ese RFC no se ve completo. Debe tener 12 o 13 caracteres (letras y números), sin espacios. Intenta de nuevo.";
  }
  return null;
}

export function validateNombre(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 3) {
    return "Escribe el nombre completo o la razón social (como aparece en tu constancia).";
  }
  if (name.includes("|")) {
    return "Solo el nombre, sin otros datos. Ejemplo: Juan Pérez López";
  }
  return null;
}

export function validateCp(raw: string): string | null {
  const cp = raw.trim();
  if (!/^\d{5}$/.test(cp)) {
    return "El código postal son 5 dígitos. Ejemplo: 06600";
  }
  return null;
}

export function draftComplete(
  d: FiscalDraft,
): d is Required<FiscalDraft> {
  return Boolean(
    d.rfc && d.razon_social && d.codigo_postal && d.regimen && d.uso_cfdi,
  );
}
