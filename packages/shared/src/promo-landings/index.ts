import { z } from 'zod';

import type { PublicLandingDto } from '../landing/types';
import type { MarketingChannelType } from '../marketing';

/**
 * Landings de promoción de la web del tenant (extra Web Premium): una página
 * con su dirección (`/promo/<slug>`), textos, foto y condiciones, con el estilo
 * de la plantilla de la web. Puede llevar un cupón que se aplica al reservar.
 */

/** Dirección de la landing: minúsculas, números y guiones. */
export const PROMO_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

/** En la edición: sin enviar = no cambia; '' o null = se borra (lo hace el servicio). */
const editText = (max: number) => z.string().trim().max(max).nullable().optional();

const isoDate = z.string().datetime({ offset: true }).nullable();

const promoFields = {
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(PROMO_SLUG_RE, 'Solo minúsculas, números y guiones'),
  isActive: z.boolean(),
  startsAt: isoDate,
  endsAt: isoDate,
  headline: z.string().trim().min(1).max(140),
  subheadline: optionalText(300),
  offerText: optionalText(80),
  body: optionalText(4000),
  benefits: z.array(z.string().trim().min(1).max(120)).max(8),
  conditions: optionalText(4000),
  ctaLabel: optionalText(40),
  couponId: z.string().uuid().nullable(),
  facilityIds: z.array(z.string().uuid()).max(100),
  unitTypeIds: z.array(z.string().uuid()).max(100),
  showCountdown: z.boolean(),
  showTestimonials: z.boolean(),
  showFaq: z.boolean(),
  showContact: z.boolean(),
  seoTitle: optionalText(70),
  seoDescription: optionalText(200),
  indexable: z.boolean(),
};

function datesIssue(v: { startsAt?: string | null; endsAt?: string | null }): string | null {
  return v.startsAt && v.endsAt && new Date(v.startsAt) >= new Date(v.endsAt)
    ? 'La fecha de fin debe ser posterior a la de inicio'
    : null;
}

export const CreatePromoLandingSchema = z
  .object({
    ...promoFields,
    isActive: promoFields.isActive.default(false),
    startsAt: promoFields.startsAt.default(null),
    endsAt: promoFields.endsAt.default(null),
    benefits: promoFields.benefits.default([]),
    couponId: promoFields.couponId.default(null),
    facilityIds: promoFields.facilityIds.default([]),
    unitTypeIds: promoFields.unitTypeIds.default([]),
    showCountdown: promoFields.showCountdown.default(false),
    showTestimonials: promoFields.showTestimonials.default(true),
    showFaq: promoFields.showFaq.default(true),
    showContact: promoFields.showContact.default(true),
    indexable: promoFields.indexable.default(false),
  })
  .superRefine((v, ctx) => {
    const issue = datesIssue(v);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: issue });
  });
export type CreatePromoLandingInput = z.infer<typeof CreatePromoLandingSchema>;

export const UpdatePromoLandingSchema = z.object({
  name: promoFields.name.optional(),
  slug: promoFields.slug.optional(),
  isActive: promoFields.isActive.optional(),
  startsAt: promoFields.startsAt.optional(),
  endsAt: promoFields.endsAt.optional(),
  headline: promoFields.headline.optional(),
  subheadline: editText(300),
  offerText: editText(80),
  body: editText(4000),
  benefits: promoFields.benefits.optional(),
  conditions: editText(4000),
  ctaLabel: editText(40),
  couponId: promoFields.couponId.optional(),
  facilityIds: promoFields.facilityIds.optional(),
  unitTypeIds: promoFields.unitTypeIds.optional(),
  showCountdown: promoFields.showCountdown.optional(),
  showTestimonials: promoFields.showTestimonials.optional(),
  showFaq: promoFields.showFaq.optional(),
  showContact: promoFields.showContact.optional(),
  seoTitle: editText(70),
  seoDescription: editText(200),
  indexable: promoFields.indexable.optional(),
});
export type UpdatePromoLandingInput = z.infer<typeof UpdatePromoLandingSchema>;

/** Comprueba las fechas sobre el resultado de una edición. */
export function promoDatesIssue(v: {
  startsAt: string | null;
  endsAt: string | null;
}): string | null {
  return datesIssue(v);
}

export const SetPromoLandingImageSchema = z.object({
  heroImageKey: z.string().min(1).max(500).nullable(),
});

export interface PromoLandingDto {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** Activa y dentro de sus fechas ahora mismo. */
  live: boolean;
  headline: string;
  subheadline: string | null;
  offerText: string | null;
  body: string | null;
  benefits: string[];
  conditions: string | null;
  ctaLabel: string | null;
  heroImageUrl: string | null;
  couponId: string | null;
  couponCode: string | null;
  facilityIds: string[];
  unitTypeIds: string[];
  showCountdown: boolean;
  showTestimonials: boolean;
  showFaq: boolean;
  showContact: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  indexable: boolean;
  createdAt: string;
  updatedAt: string;
}

/** ¿Está la landing en vigor? (activa y, si tiene fechas, dentro de ellas). */
export function promoLandingIsLive(
  p: { isActive: boolean; startsAt: Date | string | null; endsAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (!p.isActive) return false;
  if (p.startsAt && new Date(p.startsAt) > now) return false;
  if (p.endsAt && new Date(p.endsAt) <= now) return false;
  return true;
}

/** Lo que la web pública necesita de la landing. */
export interface PublicPromoLandingDto {
  slug: string;
  headline: string;
  subheadline: string | null;
  offerText: string | null;
  body: string | null;
  benefits: string[];
  conditions: string | null;
  ctaLabel: string | null;
  heroImageUrl: string | null;
  endsAt: string | null;
  showCountdown: boolean;
  showTestimonials: boolean;
  showFaq: boolean;
  showContact: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  indexable: boolean;
  /** Cupón que se aplica al reservar (si sigue activo), o null. */
  coupon: { code: string; summary: string; minMonths: number } | null;
  /** Locales y tamaños de la promoción (vacío = todos). */
  facilityIds: string[];
  unitTypeIds: string[];
}

export interface PublicPromoPageDto {
  site: PublicLandingDto;
  promo: PublicPromoLandingDto;
}

// ============================================================================
// Seguimiento (de dónde vienen las visitas)
// ============================================================================

/** `utm_campaign` de las visitas y reservas que llegan por una landing. */
export function promoCampaign(slug: string): string {
  return `promo-${slug}`;
}

/** `utm_medium` según el tipo de canal (estándar de Google Analytics). */
export function promoUtmMedium(type: MarketingChannelType): string {
  switch (type) {
    case 'google_ads':
      return 'cpc';
    case 'meta_ads':
      return 'paid_social';
    case 'physical':
      return 'offline';
    case 'real_estate_portal':
      return 'referral';
    case 'referral_program':
      return 'referral';
    default:
      return 'other';
  }
}

/** Visita a una landing (la manda la propia página al abrirse). */
export const PromoVisitSchema = z.object({
  visitorId: z.string().trim().min(8).max(64),
  source: z.string().trim().max(120).optional(),
  medium: z.string().trim().max(120).optional(),
  campaign: z.string().trim().max(160).optional(),
});
export type PromoVisitInput = z.infer<typeof PromoVisitSchema>;

// ============================================================================
// Resultados
// ============================================================================

export interface PromoLandingStatsRowDto {
  /** Origen (`utm_source`), p. ej. `flyer_buzoneo` o `web`. */
  source: string;
  visits: number;
  visitors: number;
  /** Reservas online hechas desde la landing (contratos creados). */
  bookings: number;
  signed: number;
  /** Con el primer pago cobrado. */
  paid: number;
  /** Lo cobrado en esos primeros pagos (sin la fianza). */
  revenue: number;
}

export interface PromoLandingStatsDto {
  /** Días hacia atrás (0 = desde que existe). */
  days: number;
  visits: number;
  visitors: number;
  bookings: number;
  signed: number;
  paid: number;
  revenue: number;
  /** Pagadas / visitantes, en %. */
  conversionPct: number | null;
  /** Usos del cupón de la landing en esas reservas. */
  couponUses: number;
  bySource: PromoLandingStatsRowDto[];
}
