import { z } from 'zod';

/**
 * Asistente IA que redacta (no publica) un borrador de campaña para Google
 * Ads o Meta Ads a partir de los datos reales del negocio (local, tipos de
 * trastero, precios, promoción activa) — el staff copia el texto en el
 * gestor de campañas de la plataforma. Mismo patrón single-shot que
 * `AiService.suggestReply`/`portalAnswer` (sin herramientas, sin persistir).
 */
export const AdCampaignPlatformEnum = z.enum(['google_ads', 'meta_ads']);
export type AdCampaignPlatform = z.infer<typeof AdCampaignPlatformEnum>;

export const SuggestAdCampaignSchema = z.object({
  platform: AdCampaignPlatformEnum,
  /** Local a destacar en el borrador; si se omite, usa el conjunto del tenant. */
  facilityId: z.string().uuid().optional(),
});
export type SuggestAdCampaignInput = z.infer<typeof SuggestAdCampaignSchema>;

export interface AdCampaignDraftDto {
  platform: AdCampaignPlatform;
  /** Texto formateado listo para copiar (titulares, descripciones, palabras clave, público, presupuesto). */
  draft: string;
}
