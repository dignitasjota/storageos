import { z } from 'zod';

/**
 * Códigos de devolución de los adeudos SEPA (R-transactions, ISO 20022) más
 * habituales, con lo que significan. El banco los da en la devolución.
 */
export const SEPA_RETURN_CODES = {
  AC01: 'IBAN incorrecto',
  AC04: 'Cuenta cancelada',
  AC06: 'Cuenta bloqueada',
  AC13: 'Cuenta de un particular en un adeudo entre empresas',
  AG01: 'La cuenta no admite adeudos',
  AG02: 'Código de operación no válido',
  AM04: 'Saldo insuficiente',
  AM05: 'Adeudo duplicado',
  BE05: 'Acreedor no reconocido',
  CNOR: 'El banco del acreedor no está adherido',
  DNOR: 'El banco del deudor no está adherido',
  FF01: 'Formato no válido',
  MD01: 'Sin mandato o mandato no válido',
  MD02: 'Faltan datos del mandato o son incorrectos',
  MD06: 'El titular pidió la devolución',
  MD07: 'El titular ha fallecido',
  MS02: 'El titular rechazó el adeudo',
  MS03: 'El banco no indica el motivo',
  RC01: 'BIC incorrecto',
  RR01: 'Falta la identificación del titular',
  RR02: 'Falta el nombre o la dirección del titular',
  RR03: 'Falta el nombre o la dirección del acreedor',
  RR04: 'Motivo regulatorio',
  SL01: 'Servicio específico del banco del titular',
} as const;

export type SepaReturnCode = keyof typeof SEPA_RETURN_CODES;

export const SepaReturnCodeEnum = z.enum(
  Object.keys(SEPA_RETURN_CODES) as [SepaReturnCode, ...SepaReturnCode[]],
);

/** «AM04 · Saldo insuficiente»; null si no es un código conocido. */
export function returnCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const label = (SEPA_RETURN_CODES as Record<string, string>)[code];
  return label ? `${code} · ${label}` : null;
}

/** Busca un código de devolución en un texto (el concepto que da el banco). */
export function findReturnCode(text: string | null | undefined): SepaReturnCode | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const code of Object.keys(SEPA_RETURN_CODES) as SepaReturnCode[]) {
    if (new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`).test(upper)) return code;
  }
  return null;
}
