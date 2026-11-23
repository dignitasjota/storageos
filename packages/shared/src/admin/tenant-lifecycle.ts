import { z } from 'zod';

import { normalizeCompanyName, similarCompanyNames } from './leads-insights';
import { ChurnReasonEnum, SaasPaymentProviderEnum } from './schemas';

// ============================================================================
// Dar de baja (separado de suspender)
// ============================================================================

/** «Dar de baja» un tenant: deja de cobrarse y pasa a cancelado (hoy o al acabar lo pagado). */
export const CancelTenantSchema = z.object({
  churnReason: ChurnReasonEnum,
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
  /** `now` = hoy; `period_end` = al acabar el periodo ya pagado (sigue operando hasta entonces). */
  effective: z.enum(['now', 'period_end']).default('now'),
});
export type CancelTenantInput = z.infer<typeof CancelTenantSchema>;

// ============================================================================
// Vista previa de las acciones sobre la suscripción
// ============================================================================

export const SubscriptionPreviewActionEnum = z.enum([
  'change_plan',
  'billing_mode',
  'exempt',
  'unexempt',
  'end_trial',
  'extend_trial',
  'forgive',
  'cancel',
]);
export type SubscriptionPreviewAction = z.infer<typeof SubscriptionPreviewActionEnum>;

export const SubscriptionPreviewQuerySchema = z.object({
  action: SubscriptionPreviewActionEnum,
  planSlug: z.string().trim().min(1).max(60).optional(),
  mode: z.enum(['manual', 'sepa']).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  effective: z.enum(['now', 'period_end']).optional(),
});
export type SubscriptionPreviewQuery = z.infer<typeof SubscriptionPreviewQuerySchema>;

/** Cómo queda la suscripción de un tenant (antes o después de una acción). */
export interface AdminSubscriptionStateDto {
  tenantStatus: string;
  subscriptionStatus: string | null;
  planName: string | null;
  billingMode: string | null;
  billingExempt: boolean;
  trialEndsAt: string | null;
  periodEnd: string | null;
  /** Próximo cargo de la cuota (con IVA si los precios son +IVA); null si no se cobra. */
  nextCharge: { date: string; amount: number } | null;
  /** Deuda de la cuota; null si no debe. */
  debt: { amount: number; since: string } | null;
}

export interface AdminSubscriptionPreviewDto {
  action: SubscriptionPreviewAction;
  before: AdminSubscriptionStateDto;
  after: AdminSubscriptionStateDto;
  /** Lo que pasará (correos, Stripe, remesa…). */
  effects: string[];
  /** Lo que conviene saber antes (no lo impide). */
  warnings: string[];
  /** Los precios llevan el IVA incluido. */
  pricesIncludeVat: boolean;
}

// ============================================================================
// Pagos a mano y extras asignados
// ============================================================================

/** Anular un pago a mano registrado por error. */
export const VoidSaasPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type VoidSaasPaymentInput = z.infer<typeof VoidSaasPaymentSchema>;

/** Editar un extra asignado a un tenant. */
export const UpdateTenantAddonSchema = z
  .object({
    quantity: z.number().int().min(1).max(999).optional(),
    /** Precio negociado al mes (sin IVA si los precios son +IVA). */
    priceMonthly: z.number().min(0).max(100_000).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    /** Próximo cobro (`YYYY-MM-DD`); solo extras que se cobran a mano. */
    nextChargeAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida')
      .nullable()
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Indica algo que cambiar',
  });
export type UpdateTenantAddonInput = z.infer<typeof UpdateTenantAddonSchema>;

/** «Cobrar ahora» un extra desde la ficha del tenant. */
export const ChargeTenantAddonNowSchema = z.object({
  provider: SaasPaymentProviderEnum.default('cash'),
});
export type ChargeTenantAddonNowInput = z.infer<typeof ChargeTenantAddonNowSchema>;

// ============================================================================
// Incoherencias de la suscripción
// ============================================================================

export const ConsistencyCodeEnum = z.enum([
  'trial_expired',
  'paid_still_trial',
  'trial_subscription_on_active',
  'cancelled_still_charging',
  'exempt_with_autocharge',
  'trial_period_mismatch',
  'stripe_addons_without_subscription',
  'suspended_with_autocharge',
  'anonymized_with_live_subscription',
]);
export type ConsistencyCode = z.infer<typeof ConsistencyCodeEnum>;

export interface AdminConsistencyIssueDto {
  code: ConsistencyCode;
  title: string;
  detail: string;
  /** Texto del botón «Corregir» (null = no se corrige solo). */
  fixLabel: string | null;
}

export interface AdminTenantConsistencyDto {
  issues: AdminConsistencyIssueDto[];
}

// ============================================================================
// Anonimización programada
// ============================================================================

export interface AdminAnonymizeResultDto {
  tenantId: string;
  /** Fecha en que se borrará (programada); null si se hizo ya. */
  scheduledFor: string | null;
  anonymizedCustomers: number;
  anonymizedUsers: number;
}

// ============================================================================
// Usuarios del tenant: correo y propiedad
// ============================================================================

export const AdminChangeUserEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email no válido').max(320),
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type AdminChangeUserEmailInput = z.infer<typeof AdminChangeUserEmailSchema>;

export const AdminTransferOwnershipSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type AdminTransferOwnershipInput = z.infer<typeof AdminTransferOwnershipSchema>;

// ============================================================================
// Alta manual: posibles duplicados
// ============================================================================

export const TenantDuplicatesQuerySchema = z.object({
  name: z.string().trim().max(100).optional(),
  email: z.string().trim().max(320).optional(),
  taxId: z.string().trim().max(30).optional(),
  billingEmail: z.string().trim().max(320).optional(),
});
export type TenantDuplicatesQuery = z.infer<typeof TenantDuplicatesQuerySchema>;

export interface AdminTenantDuplicateDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** Por qué se parece («Mismo NIF», «Nombre parecido»…). */
  matches: string[];
}

function bigrams(text: string): string[] {
  const t = text.replace(/\s+/g, ' ');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Parecido 0-1 entre dos nombres de empresa (coeficiente de Dice por pares de letras). */
export function companyNameSimilarity(a: string, b: string): number {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (bx.length === 0 || by.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of bx) counts.set(g, (counts.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of by) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * common) / (bx.length + by.length);
}

/**
 * Dos nombres de empresa que parecen el mismo negocio: iguales sin la forma
 * jurídica, uno dentro del otro o casi iguales (una letra de más o de menos).
 */
export function isSimilarCompanyName(a: string, b: string): boolean {
  return similarCompanyNames(a, b) || companyNameSimilarity(a, b) >= 0.85;
}

// ============================================================================
// Correo al tenant: destinatarios
// ============================================================================

export interface AdminTenantEmailRecipientDto {
  email: string;
  /** «Propietario», «Email de facturación», «Gestor»… */
  label: string;
  kind: 'owner' | 'billing' | 'user';
  fullName: string | null;
  /** Se marca de entrada (los que reciben siempre los correos del admin). */
  defaultSelected: boolean;
  /** Email verificado (los usuarios). */
  verified: boolean;
  /** Dirección bloqueada (rebote o queja): motivo legible; null si se puede enviar. */
  blocked: string | null;
}

// ============================================================================
// Exportaciones de datos del tenant
// ============================================================================

export interface AdminTenantDataExportDto {
  id: string;
  status: 'pending' | 'done' | 'failed';
  requestedByName: string | null;
  createdAt: string;
  finishedAt: string | null;
  fileBytes: number | null;
  /** Filas por hoja. */
  counts: Record<string, number> | null;
  error: string | null;
  /** El fichero ya no está (se borra a los 2 días). */
  expired: boolean;
}

// ============================================================================
// Historial
// ============================================================================

export const PinInteractionSchema = z.object({ pinned: z.boolean() });
export type PinInteractionInput = z.infer<typeof PinInteractionSchema>;
