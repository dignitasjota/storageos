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
]);
export type OpportunityKind = z.infer<typeof OpportunityKindEnum>;

export const OPPORTUNITY_LABELS: Record<OpportunityKind, string> = {
  insurance: 'Seguro de contenido',
  larger_unit: 'Trastero más grande',
  additional_unit: 'Otro trastero',
  night_pass: 'Pase nocturno / acceso 24 h',
  autopay: 'Domiciliar el pago',
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
});
export type ProposeOpportunityInput = z.infer<typeof ProposeOpportunitySchema>;

export interface OpportunityDraftDto {
  subject: string;
  body: string;
  /** Texto corto para WhatsApp (se abre con wa.me desde el panel). */
  whatsappText: string;
  portalUrl: string;
}

export interface ProposeOpportunityResultDto {
  emailSent: boolean;
  followupId: string | null;
}
