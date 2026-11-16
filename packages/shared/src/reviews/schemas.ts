import { z } from 'zod';

export const ReviewStatusEnum = z.enum(['pending', 'submitted', 'expired']);
export type ReviewStatusValue = z.infer<typeof ReviewStatusEnum>;

export const ReviewChannelEnum = z.enum(['email', 'whatsapp', 'manual']);
export type ReviewChannelValue = z.infer<typeof ReviewChannelEnum>;

/** Por qué se va un inquilino (encuesta de salida). */
export const REVIEW_EXIT_REASONS = [
  'price',
  'no_longer_needed',
  'moving',
  'space',
  'service',
  'other',
] as const;
export type ReviewExitReason = (typeof REVIEW_EXIT_REASONS)[number];
export const REVIEW_EXIT_REASON_LABELS: Record<ReviewExitReason, string> = {
  price: 'El precio',
  no_longer_needed: 'Ya no lo necesito',
  moving: 'Me mudo',
  space: 'Necesito otro tamaño',
  service: 'El servicio o el local',
  other: 'Otro motivo',
};

/** Solicitud de valoración desde el panel (staff). */
export const RequestReviewSchema = z.object({
  customerId: z.string().uuid(),
  contractId: z.string().uuid().optional(),
  channel: z.enum(['email', 'whatsapp']).default('email'),
});
export type RequestReviewInput = z.infer<typeof RequestReviewSchema>;

/** Valoración enviada por el inquilino desde la página pública. */
export const SubmitReviewSchema = z.object({
  npsScore: z.number().int().min(0).max(10),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().trim().max(2000).optional().or(z.literal('')),
  /** Permiso para publicar la opinión en la web del negocio (nombre e inicial). */
  publishConsent: z.boolean().optional(),
  /** Encuesta de salida: por qué se va. */
  exitReason: z.enum(REVIEW_EXIT_REASONS).optional(),
  /** Honeypot anti-bot: debe venir vacío. */
  website: z.string().optional(),
});
export type SubmitReviewInput = z.infer<typeof SubmitReviewSchema>;

/** Filtros de la lista de valoraciones del panel. */
export const ReviewListQuerySchema = z.object({
  status: ReviewStatusEnum.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ReviewListQueryInput = z.infer<typeof ReviewListQuerySchema>;

/** Periodo y local de las cifras de valoraciones. */
export const ReviewStatsQuerySchema = z.object({
  /** Meses hacia atrás (sin valor, todo). */
  months: z.coerce.number().int().min(1).max(36).optional(),
  facilityId: z.string().uuid().optional(),
});
export type ReviewStatsQueryInput = z.infer<typeof ReviewStatsQuerySchema>;

/** Publicar (o retirar) una valoración como testimonio en la web pública. */
export const PublishReviewSchema = z.object({ published: z.boolean() });
export type PublishReviewInput = z.infer<typeof PublishReviewSchema>;
