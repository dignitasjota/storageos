import { z } from 'zod';

/**
 * Oportunidades de venta sobre los inquilinos: lo que el sistema sugiere
 * ofrecer (nunca lo aplica solo) y la señal que lo justifica.
 */
export const OpportunityKindEnum = z.enum([
  'insurance',
  'larger_unit',
  'additional_unit',
  'night_pass',
  'autopay',
  'annual_prepay',
  'renewal',
  'incomplete_data',
  'google_review',
  'referral',
  'smaller_unit',
]);
export type OpportunityKind = z.infer<typeof OpportunityKindEnum>;

export const OPPORTUNITY_LABELS: Record<OpportunityKind, string> = {
  insurance: 'Seguro de contenido',
  larger_unit: 'Trastero más grande',
  additional_unit: 'Otro trastero',
  night_pass: 'Pase nocturno / acceso 24 h',
  autopay: 'Domiciliar el pago',
  annual_prepay: 'Pago anual por adelantado',
  renewal: 'Renovar el contrato',
  incomplete_data: 'Completar sus datos',
  google_review: 'Reseña en Google',
  referral: 'Recomendar a un amigo',
  smaller_unit: 'Trastero más pequeño',
};

/** Lo que el área de clientes registra cuando el inquilino mira y no contrata. */
export const InterestKindEnum = z.enum([
  'insurance',
  'additional_unit',
  'larger_unit',
  'night_pass',
]);
export type InterestKind = z.infer<typeof InterestKindEnum>;

export const PortalInterestSchema = z.object({
  kind: InterestKindEnum,
  unitTypeId: z.string().uuid().optional(),
});
export type PortalInterestInput = z.infer<typeof PortalInterestSchema>;

export interface OpportunityDto {
  /** `<customerId>:<kind>` */
  id: string;
  kind: OpportunityKind;
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  units: string[];
  /** Por qué se sugiere («miró el seguro 3 veces en 30 días»). */
  reason: string;
  /** Lo que se ofrecería, con su precio con IVA si lo hay. */
  offer: string;
  priceMonthlyGross: number | null;
  /** Ingreso mensual extra (sin IVA) si acepta. */
  monthlyValue: number;
  /** Más alto = más prometedora. */
  score: number;
  lastProposedAt: string | null;
  /** Qué hizo con la última propuesta en su área de clientes. */
  lastOfferStatus: CustomerOfferStatus | null;
  /** Locales de sus trasteros (para filtrar). */
  facilityIds: string[];
}

export interface OpportunitiesDto {
  items: OpportunityDto[];
  byKind: Record<OpportunityKind, { count: number; monthlyValue: number }>;
}

export const ProposeOpportunitySchema = z.object({
  customerId: z.string().uuid(),
  kind: OpportunityKindEnum,
  /** Texto del correo; si no viene, el propuesto por el sistema. */
  subject: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(10).max(5000).optional(),
  /** Seguimiento a los N días (0 = sin seguimiento). */
  followupInDays: z.number().int().min(0).max(60).default(7),
  /**
   * `email`: se envía por correo. `whatsapp`: el equipo la mandó por WhatsApp
   * desde su móvil; solo se registra (área de clientes y seguimiento).
   */
  channel: z.enum(['email', 'whatsapp']).default('email'),
});
export type ProposeOpportunityInput = z.infer<typeof ProposeOpportunitySchema>;

export interface OpportunityDraftDto {
  subject: string;
  body: string;
  /** Texto corto para WhatsApp (se abre con wa.me desde el panel). */
  whatsappText: string;
  portalUrl: string;
  /** Lo que se le enseña en su área de clientes. */
  offerText: string;
}

export interface ProposeOpportunityResultDto {
  emailSent: boolean;
  followupId: string | null;
}

/** Estado de una propuesta en el área de clientes del inquilino. */
export const CustomerOfferStatusEnum = z.enum([
  'open',
  'interested',
  'declined',
  'accepted',
  'expired',
]);
export type CustomerOfferStatus = z.infer<typeof CustomerOfferStatusEnum>;

/** Una propuesta del negocio, vista por el inquilino en su portal. */
export interface PortalOfferDto {
  id: string;
  kind: OpportunityKind;
  title: string;
  message: string;
  priceGross: number | null;
  status: CustomerOfferStatus;
  createdAt: string;
  expiresAt: string;
  /** Enlace externo de la oferta (p. ej. la reseña en Google). */
  url: string | null;
}

export const PortalRespondOfferSchema = z.object({
  response: z.enum(['interested', 'declined']),
});
export type PortalRespondOfferInput = z.infer<typeof PortalRespondOfferSchema>;

// --- Mejoras (2026-11-15) ----------------------------------------------------

/** Descartar (para siempre) o posponer N días una oportunidad. */
export const DismissOpportunitySchema = z.object({
  customerId: z.string().uuid(),
  kind: OpportunityKindEnum,
  /** null = para siempre. */
  days: z.number().int().min(1).max(365).nullable(),
  reason: z.string().trim().max(500).optional(),
});
export type DismissOpportunityInput = z.infer<typeof DismissOpportunitySchema>;

export interface OpportunityDismissalDto {
  customerId: string;
  customerName: string;
  kind: OpportunityKind;
  until: string | null;
  reason: string | null;
  userName: string | null;
  createdAt: string;
}

/** Proponer la misma oportunidad a varios a la vez (por correo, con el texto sugerido). */
export const ProposeBulkSchema = z.object({
  items: z
    .array(z.object({ customerId: z.string().uuid(), kind: OpportunityKindEnum }))
    .min(1)
    .max(100),
  followupInDays: z.number().int().min(0).max(60).default(7),
});
export type ProposeBulkInput = z.infer<typeof ProposeBulkSchema>;

export interface ProposeBulkResultDto {
  sent: number;
  skipped: { customerId: string; kind: OpportunityKind; reason: string }[];
}

export interface OpportunityResultRowDto {
  proposed: number;
  seen: number;
  interested: number;
  accepted: number;
  declined: number;
  /** Ingreso mensual (sin IVA) de las aceptadas. */
  monthlyValue: number;
}

export interface OpportunityResultsDto {
  days: number;
  totals: OpportunityResultRowDto;
  byKind: Record<OpportunityKind, OpportunityResultRowDto>;
}

export interface OpportunityInterestedCountDto {
  interested: number;
}
