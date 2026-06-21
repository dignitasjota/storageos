import { z } from 'zod';

export const ReviewStatusEnum = z.enum(['pending', 'submitted', 'expired']);
export type ReviewStatusValue = z.infer<typeof ReviewStatusEnum>;

export const ReviewChannelEnum = z.enum(['email', 'whatsapp', 'manual']);
export type ReviewChannelValue = z.infer<typeof ReviewChannelEnum>;

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
