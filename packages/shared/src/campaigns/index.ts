import { z } from 'zod';

import { LeadStatusEnum } from '../communications/schemas';

/** `scheduled` = correos ya encolados para la fecha programada (aún se puede cancelar). */
export const CampaignStatusEnum = z.enum(['draft', 'sending', 'scheduled', 'sent', 'cancelled']);
export type CampaignStatusValue = z.infer<typeof CampaignStatusEnum>;

/**
 * Criterios de segmentación de una campaña (discriminados por audiencia).
 * - `customers`: por contrato activo, morosidad y tag.
 * - `leads`: por estado y origen.
 */
export const CustomerSegmentSchema = z.object({
  audience: z.literal('customers'),
  /**
   * active = con contrato active/ending; none = sin él; any = todos;
   * former = ex-clientes (tuvieron un contrato ended/cancelled y ninguno
   * activo) → segmento de win-back.
   */
  contractStatus: z.enum(['active', 'none', 'any', 'former']).default('any'),
  /** Solo clientes con facturas vencidas (morosos). */
  overdueOnly: z.boolean().default(false),
  /** Solo clientes con este tag. */
  tag: z.string().trim().max(60).optional().or(z.literal('')),
  /** Solo clientes de este local (por sus contratos). */
  facilityId: z.string().uuid().optional(),
});

export const LeadSegmentSchema = z.object({
  audience: z.literal('leads'),
  leadStatus: LeadStatusEnum.optional(),
  leadSource: z.string().trim().min(1).max(60).optional(),
  /** Solo contactos que prefieren este local. */
  facilityId: z.string().uuid().optional(),
});

export const CampaignSegmentSchema = z.discriminatedUnion('audience', [
  CustomerSegmentSchema,
  LeadSegmentSchema,
]);
export type CampaignSegmentInput = z.infer<typeof CampaignSegmentSchema>;

export const CreateCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  subject: z.string().trim().min(2).max(200),
  /** Cuerpo del email; admite Handlebars `{{customer.firstName}}` / `{{lead.firstName}}`. */
  bodyText: z.string().trim().min(2).max(20_000),
  segment: CampaignSegmentSchema,
  /** Programar el envío (ISO). Si se omite, se envía de inmediato al pulsar Enviar. */
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

/** Previsualiza el tamaño de la audiencia antes de crear/enviar. */
export const PreviewCampaignSchema = z.object({
  segment: CampaignSegmentSchema,
});
export type PreviewCampaignInput = z.infer<typeof PreviewCampaignSchema>;

export interface CampaignDto {
  id: string;
  name: string;
  channel: string;
  subject: string;
  bodyText: string;
  segment: CampaignSegmentInput;
  status: CampaignStatusValue;
  audienceCount: number;
  sentCount: number;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface CampaignPreviewDto {
  /** Destinatarios con email válido que recibirían la campaña. */
  audienceCount: number;
}

// ============================================================================
// Win-back automático de bajas
// ============================================================================

/** Sugerencias por defecto para la oferta de vuelta (editables por el operador). */
export const DEFAULT_WINBACK_SUBJECT = 'Te echamos de menos 👋';
export const DEFAULT_WINBACK_BODY =
  'Hola {{customer.firstName}},\n\n' +
  'Hace un tiempo confiaste en {{tenant.name}} para guardar tus cosas. ' +
  'Si vuelves a necesitar espacio, nos encantaría verte de nuevo — y esta vez con una oferta especial.\n\n' +
  'Escríbenos o pásate por el local y te lo ponemos fácil.\n\n' +
  'Un saludo,\n{{tenant.name}}';

export const UpdateWinbackSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Días tras la baja para enviar la oferta de vuelta. */
    delayDays: z.number().int().min(1).max(730).optional(),
    subject: z.string().trim().max(200).optional().or(z.literal('')),
    bodyText: z.string().trim().max(20_000).optional().or(z.literal('')),
    /** Segundo aviso a quien no volvió, con un cupón. */
    secondEnabled: z.boolean().optional(),
    /** Días tras el primer aviso. */
    secondDelayDays: z.number().int().min(7).max(365).optional(),
    secondSubject: z.string().trim().max(200).optional().or(z.literal('')),
    secondBodyText: z.string().trim().max(20_000).optional().or(z.literal('')),
    /** Código del cupón que se ofrece (debe existir en Cupones). */
    secondCouponCode: z.string().trim().max(40).optional().or(z.literal('')),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWinbackSettingsInput = z.infer<typeof UpdateWinbackSettingsSchema>;

export interface WinbackSettingsResponse {
  enabled: boolean;
  delayDays: number;
  /** null = se usa el texto por defecto (`DEFAULT_WINBACK_*`). */
  subject: string | null;
  bodyText: string | null;
  secondEnabled: boolean;
  secondDelayDays: number;
  secondSubject: string | null;
  secondBodyText: string | null;
  secondCouponCode: string | null;
}

export interface WinbackRunResultDto {
  /** Ex-clientes a los que se les encoló la oferta en esta ejecución. */
  sent: number;
  /** Segundos avisos encolados. */
  secondSent: number;
}

/** Ex-clientes que recibieron el win-back y volvieron a firmar. */
export interface WinbackStatsDto {
  firstSent: number;
  secondSent: number;
  recovered: number;
  /** % de recuperados sobre los que recibieron el primer aviso. */
  recoveryRate: number | null;
}

export const DEFAULT_WINBACK_SECOND_SUBJECT = 'Última oportunidad: vuelve con descuento';
export const DEFAULT_WINBACK_SECOND_BODY =
  'Hola {{customer.firstName}},\n\nTe guardamos un descuento para que vuelvas a {{tenant.name}}. Usa el cupón {{coupon.code}} al reservar tu trastero.\n\nUn saludo,\n{{tenant.name}}';

// ============================================================================
// Resultados de una campaña
// ============================================================================

export interface CampaignLinkResultDto {
  url: string;
  clicks: number;
}

export interface CampaignResultsDto {
  campaignId: string;
  recipients: number;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  skipped: number;
  /** Destinatarios que se dieron de baja de las comunicaciones comerciales tras recibirla. */
  unsubscribed: number;
  /** Destinatarios distintos que pulsaron algún enlace. */
  clickers: number;
  /** % de destinatarios enviados que pulsaron algún enlace. */
  clickRate: number | null;
  links: CampaignLinkResultDto[];
}

// ============================================================================
// Plantillas de campaña y vista previa
// ============================================================================

export const CreateCampaignTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20_000),
});
export type CreateCampaignTemplateInput = z.infer<typeof CreateCampaignTemplateSchema>;

export const UpdateCampaignTemplateSchema = CreateCampaignTemplateSchema.partial();
export type UpdateCampaignTemplateInput = z.infer<typeof UpdateCampaignTemplateSchema>;

export interface CampaignTemplateDto {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  updatedAt: string;
}

export const CampaignEmailPreviewSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20_000),
  audience: z.enum(['customers', 'leads']).default('customers'),
});
export type CampaignEmailPreviewInput = z.infer<typeof CampaignEmailPreviewSchema>;

export interface CampaignEmailPreviewDto {
  subject: string;
  html: string;
}
