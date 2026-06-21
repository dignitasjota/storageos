import type { ReviewChannelValue, ReviewStatusValue } from './schemas';

export interface ReviewDto {
  id: string;
  customerId: string;
  customerName: string;
  contractId: string | null;
  contractNumber: string | null;
  status: ReviewStatusValue;
  npsScore: number | null;
  rating: number | null;
  comment: string | null;
  channel: ReviewChannelValue | null;
  requestedAt: string;
  submittedAt: string | null;
  createdAt: string;
}

export interface ReviewListDto {
  items: ReviewDto[];
  nextCursor: string | null;
}

/**
 * Agregados de valoraciones del tenant. `npsScore` = %promotores (9-10) −
 * %detractores (0-6), redondeado, sobre las valoraciones enviadas (null si no
 * hay ninguna).
 */
export interface ReviewStatsDto {
  total: number;
  submitted: number;
  pending: number;
  npsScore: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  avgRating: number | null;
  responseRate: number;
}

export interface RequestReviewResultDto {
  id: string;
  reviewUrl: string;
  /** true si se encoló el envío (email/WhatsApp); false si fue solo creación. */
  enqueued: boolean;
}

/** Contexto que ve la página pública de valoración antes de enviarla. */
export interface PublicReviewContextDto {
  status: ReviewStatusValue;
  tenantName: string;
  customerFirstName: string;
  facilityName: string | null;
}
