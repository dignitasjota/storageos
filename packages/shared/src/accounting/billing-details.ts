import { z } from 'zod';

/**
 * Datos fiscales obligatorios de una factura completa (art. 6 del Reglamento de
 * facturación, RD 1619/2012): número y serie, fecha, nombre o razón social, NIF
 * y domicilio del emisor y del destinatario, descripción, base, tipo y cuota.
 * Aquí se comprueban los que dependen de datos que rellena alguien: el resto
 * los pone siempre la app.
 */

const CIF_LETTERS = 'JABCDEFGHI';
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Normaliza un NIF/CIF: mayúsculas, sin espacios, guiones ni prefijo «ES». */
export function normalizeTaxId(value: string): string {
  return value
    .toUpperCase()
    .replace(/[\s.-]/g, '')
    .replace(/^ES(?=[0-9A-Z]{9}$)/, '');
}

/** Valida un NIF (DNI), NIE o CIF español, con su dígito de control. */
export function isValidSpanishTaxId(value: string): boolean {
  const v = normalizeTaxId(value);
  // DNI: 8 dígitos + letra.
  if (/^\d{8}[A-Z]$/.test(v)) {
    return DNI_LETTERS[Number(v.slice(0, 8)) % 23] === v[8];
  }
  // NIE: X/Y/Z + 7 dígitos + letra.
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {
    const num = Number(String('XYZ'.indexOf(v[0]!)) + v.slice(1, 8));
    return DNI_LETTERS[num % 23] === v[8];
  }
  // CIF: letra de entidad + 7 dígitos + control (dígito o letra).
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) {
    const digits = v.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const d = Number(digits[i]);
      if (i % 2 === 0) {
        const doubled = d * 2;
        sum += Math.floor(doubled / 10) + (doubled % 10);
      } else {
        sum += d;
      }
    }
    const control = (10 - (sum % 10)) % 10;
    const last = v[8]!;
    return last === String(control) || last === CIF_LETTERS[control];
  }
  return false;
}

export interface FiscalParty {
  name: string | null | undefined;
  taxId: string | null | undefined;
  address: string | null | undefined;
  city: string | null | undefined;
  postalCode: string | null | undefined;
  country?: string | null | undefined;
}

/**
 * Datos obligatorios que faltan (o son inválidos) en un emisor o destinatario.
 * Devuelve etiquetas legibles en español; vacío = completo.
 */
export function missingFiscalData(party: FiscalParty): string[] {
  const missing: string[] = [];
  const blank = (v: string | null | undefined) => !v || v.trim() === '';
  if (blank(party.name)) missing.push('Razón social');
  if (blank(party.taxId)) {
    missing.push('NIF');
  } else if ((party.country ?? 'ES') === 'ES' && !isValidSpanishTaxId(party.taxId!)) {
    missing.push('NIF válido');
  }
  if (blank(party.address)) missing.push('Dirección');
  if (blank(party.city)) missing.push('Población');
  if (blank(party.postalCode)) missing.push('Código postal');
  return missing;
}

/** Datos de facturación que el tenant rellena para sus facturas de suscripción. */
export const TenantBillingDetailsSchema = z
  .object({
    legalName: z.string().trim().min(1, 'Indica la razón social').max(200),
    taxId: z.string().trim().min(1, 'Indica el NIF').max(40).transform(normalizeTaxId),
    address: z.string().trim().min(1, 'Indica la dirección').max(300),
    city: z.string().trim().min(1, 'Indica la población').max(120),
    postalCode: z.string().trim().min(1, 'Indica el código postal').max(20),
    country: z.string().trim().length(2).toUpperCase().default('ES'),
    billingEmail: z.string().trim().email().max(320).nullable().optional().or(z.literal('')),
  })
  .superRefine((v, ctx) => {
    if (v.country === 'ES' && !isValidSpanishTaxId(v.taxId)) {
      ctx.addIssue({ code: 'custom', path: ['taxId'], message: 'NIF o CIF no válido' });
    }
  });
export type TenantBillingDetailsInput = z.infer<typeof TenantBillingDetailsSchema>;

export interface TenantBillingDetailsDto {
  legalName: string | null;
  taxId: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  billingEmail: string | null;
  /** Datos que faltan para que las facturas salgan completas (vacío = completo). */
  missing: string[];
}
