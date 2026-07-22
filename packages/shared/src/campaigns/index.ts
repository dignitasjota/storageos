import { z } from 'zod';

import { LeadStatusEnum } from '../communications/schemas';

export const CampaignStatusEnum = z.enum(['draft', 'sending', 'sent', 'cancelled']);
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
});

export const LeadSegmentSchema = z.object({
  audience: z.literal('leads'),
  leadStatus: LeadStatusEnum.optional(),
  leadSource: z.string().trim().min(1).max(60).optional(),
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
