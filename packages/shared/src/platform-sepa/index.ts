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

// ---------------------------------------------------------------------------
// Remesas (una línea por tenant+periodo, no por factura)
// ---------------------------------------------------------------------------

export const CreatePlatformSepaRemittanceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** Fecha de cobro (YYYY-MM-DD). */
  collectionDate: dateOnly,
  /** Tenants a incluir; si se omite, se incluyen todos los elegibles. */
  tenantIds: z.array(z.string().uuid()).optional(),
});
export type CreatePlatformSepaRemittanceInput = z.infer<typeof CreatePlatformSepaRemittanceSchema>;

export interface PlatformSepaEligibleTenantDto {
  tenantId: string;
  tenantName: string;
  periodCovered: string;
  amount: number;
  mandateReference: string;
  ibanLast4: string;
  sequenceType: 'FRST' | 'RCUR';
}

export interface PlatformSepaRemittancePreviewDto {
  eligible: PlatformSepaEligibleTenantDto[];
  total: number;
  /** Tenants en modo 'sepa' sin mandato activo (no se pueden incluir). */
  withoutMandate: { tenantId: string; tenantName: string }[];
}

export interface PlatformSepaRemittanceItemDto {
  id: string;
  tenantId: string;
  tenantName: string;
  amount: number;
  periodCovered: string;
  itemStatus: 'pending' | 'collected' | 'bounced';
  bouncedAt: string | null;
  bounceReason: string | null;
}

export interface PlatformSepaRemittanceDto {
  id: string;
  name: string;
  messageId: string;
  collectionDate: string;
  status: 'generated' | 'confirmed' | 'cancelled';
  itemCount: number;
  total: number;
  createdAt: string;
  confirmedAt: string | null;
  /** true si `PlatformSepaSettings` cambió después de generar el XML — el
   * creditor embebido en el XML puede estar desactualizado. */
  creditorMayBeStale?: boolean;
  items?: PlatformSepaRemittanceItemDto[];
}

/** Marca un item de remesa como devuelto por el banco (Fase 3). */
export const BouncePlatformSepaRemittanceItemSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});
export type BouncePlatformSepaRemittanceItemInput = z.infer<
  typeof BouncePlatformSepaRemittanceItemSchema
>;
