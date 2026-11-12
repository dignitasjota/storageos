import { z } from 'zod';

/** Tramo de precio de un extra: desde `minQuantity` unidades, `unitPrice` cada una. */
export const AddonPriceTierSchema = z.object({
  minQuantity: z.number().int().min(1).max(100000),
  unitPrice: z.number().min(0).max(100000),
});
export type AddonPriceTier = z.infer<typeof AddonPriceTierSchema>;

export const AddonPriceTiersSchema = z
  .array(AddonPriceTierSchema)
  .max(10)
  .refine((tiers) => new Set(tiers.map((t) => t.minQuantity)).size === tiers.length, {
    message: 'Cada tramo debe empezar en una cantidad distinta',
  });

/** Lee los tramos guardados (jsonb) y los ordena por cantidad. */
export function parseAddonPriceTiers(value: unknown): AddonPriceTier[] {
  const parsed = AddonPriceTiersSchema.safeParse(value);
  if (!parsed.success) return [];
  return [...parsed.data].sort((a, b) => a.minQuantity - b.minQuantity);
}

/**
 * Precio por unidad de un extra para una cantidad: el del tramo más alto que
 * alcanza (desde 1 unidad, el precio base si no hay tramo que lo cubra).
 */
export function addonUnitPrice(
  basePrice: number,
  tiers: AddonPriceTier[] | null | undefined,
  quantity: number,
): number {
  let price = basePrice;
  for (const t of [...(tiers ?? [])].sort((a, b) => a.minQuantity - b.minQuantity)) {
    if (quantity >= t.minQuantity) price = t.unitPrice;
  }
  return Math.round(price * 100) / 100;
}

/** Vista previa de un cambio de precio de un plan. */
export interface PlanPricePreviewDto {
  planId: string;
  /** Tenants en el plan (sin borrar). */
  tenants: number;
  /** De ellos, los que pagan (suscripción activa, sin exentos). */
  payingTenants: number;
  /** De los que pagan, los que lo hacen por Stripe: su cargo no cambia hasta cambiar el Price. */
  stripeTenants: number;
  currentMrr: number;
  newMrr: number;
  delta: number;
}

/** Un cambio de precio de un plan o extra. */
export interface CatalogPriceChangeDto {
  id: string;
  kind: 'plan' | 'addon';
  itemId: string;
  itemName: string;
  oldPriceMonthly: number | null;
  newPriceMonthly: number | null;
  oldPriceYearly: number | null;
  newPriceYearly: number | null;
  superAdminName: string | null;
  createdAt: string;
}

/** Un uso de un cupón de plataforma. */
export interface PlatformCouponRedemptionDto {
  id: string;
  tenantId: string;
  tenantName: string;
  source: 'manual' | 'stripe';
  discount: number | null;
  createdAt: string;
}

export interface PlatformCouponRedemptionsDto {
  items: PlatformCouponRedemptionDto[];
  totalDiscount: number;
  tenants: number;
}

export const QuoteOfferStatusEnum = z.enum(['sent', 'accepted', 'rejected']);
export type QuoteOfferStatus = z.infer<typeof QuoteOfferStatusEnum>;

export const UpdateQuoteOfferSchema = z.object({
  status: QuoteOfferStatusEnum,
});
export type UpdateQuoteOfferInput = z.infer<typeof UpdateQuoteOfferSchema>;

/** Una propuesta de cuota enviada a un tenant. */
export interface PlatformQuoteOfferDto {
  id: string;
  /** null = enviada a un lead que aún no tiene cuenta. */
  tenantId: string | null;
  tenantName: string | null;
  leadId: string | null;
  leadName: string | null;
  planId: string;
  planName: string;
  cycle: 'monthly' | 'yearly';
  addons: { addonId: string; quantity: number }[];
  couponCode: string | null;
  total: number;
  status: QuoteOfferStatus;
  resolvedAt: string | null;
  createdAt: string;
  superAdminName: string | null;
  /** Enlace para aceptarla: Suscripción del tenant, o el registro si es de un lead. */
  acceptUrl: string;
}

export interface PlatformQuoteOffersDto {
  items: PlatformQuoteOfferDto[];
  /** Últimos 90 días. */
  stats: { sent: number; accepted: number; rejected: number; conversionPct: number | null };
}

/** Comisión propia de un tenant por los cobros con tarjeta. */
export const SetTenantApplicationFeeSchema = z.object({
  /** null = vuelve a la comisión general. */
  applicationFeePct: z.number().min(0).max(10).nullable(),
});
export type SetTenantApplicationFeeInput = z.infer<typeof SetTenantApplicationFeeSchema>;

export interface TenantApplicationFeeDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  applicationFeePct: number;
}

/** Comisión cobrada por mes y por tenant. */
export interface ApplicationFeeReportDto {
  months: { month: string; fee: number; charges: number }[];
  topTenants: { tenantId: string; tenantName: string; fee: number }[];
  total: number;
}
