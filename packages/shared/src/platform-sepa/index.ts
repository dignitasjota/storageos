import { z } from 'zod';

import { isValidIban, normalizeIban } from '../sepa';

/**
 * Cobro de la cuota de suscripción SaaS por domiciliación SEPA directa
 * (deudor = el TENANT, acreedor = la plataforma). Espejo de `../sepa`
 * (tenant→inquilino) pero a nivel plataforma (plataforma→tenant); reutiliza
 * las mismas reglas de validación de IBAN/BIC/fecha.
 */

const ibanSchema = z
  .string()
  .trim()
  .transform(normalizeIban)
  .refine(isValidIban, { message: 'IBAN no válido (dígito de control incorrecto)' });

const bicSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'BIC no válido')
  .optional()
  .or(z.literal(''));

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Settings del acreedor (la plataforma; singleton, no por tenant)
// ---------------------------------------------------------------------------

export const UpdatePlatformSepaSettingsSchema = z.object({
  creditorName: z.string().trim().min(2).max(140),
  /** Identificador del acreedor SEPA de la plataforma (p.ej. ES12ZZZ+NIF). */
  creditorId: z.string().trim().min(8).max(35),
  /** Opcional al actualizar: si se omite, se conserva el IBAN ya guardado. */
  creditorIban: ibanSchema.optional(),
  creditorBic: bicSchema,
  enabled: z.boolean().default(false),
});
export type UpdatePlatformSepaSettingsInput = z.infer<typeof UpdatePlatformSepaSettingsSchema>;

export interface PlatformSepaSettingsDto {
  configured: boolean;
  creditorName: string;
  creditorId: string;
  creditorIbanLast4: string | null;
  creditorBic: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Mandato (deudor = el tenant; autoservicio, nunca lo crea el admin)
// ---------------------------------------------------------------------------

export const CreatePlatformSepaMandateSchema = z.object({
  iban: ibanSchema,
  bic: bicSchema,
  /** Fecha de firma del mandato (YYYY-MM-DD). */
  signedAt: dateOnly,
});
export type CreatePlatformSepaMandateInput = z.infer<typeof CreatePlatformSepaMandateSchema>;

export interface PlatformSepaMandateDto {
  id: string;
  tenantId: string;
  reference: string;
  ibanLast4: string;
  bic: string | null;
  signedAt: string;
  sequenceType: 'FRST' | 'RCUR';
  status: 'active' | 'cancelled';
  createdAt: string;
}
