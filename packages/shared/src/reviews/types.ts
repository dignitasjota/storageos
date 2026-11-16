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
  /** El equipo la ha publicado en la web pública (testimonio). */
  publishedOnWeb: boolean;
  /** Su autor dio permiso para publicarla en la web. */
  publishConsent: boolean;
  /** Motivo de la baja (encuesta de salida). */
  exitReason: string | null;
  /** Es una encuesta de salida. */
  exit: boolean;
  /** Cuándo se le recordó. */
  remindedAt: string | null;
  /** Enlace para responderla mientras está pendiente (null si no). */
  reviewUrl: string | null;
  /** Cuándo se le pidió la reseña en Google (null = aún no). */
  googleRequestedAt: string | null;
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
  /** Marca del negocio para pintar la página con su aspecto. */
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customerFirstName: string;
  facilityName: string | null;
  /** Encuesta de salida: se pregunta por qué se va. */
  exit: boolean;
}

/** NPS mes a mes y por local. */
export interface ReviewInsightsDto {
  trend: { month: string; responses: number; nps: number | null; avgRating: number | null }[];
  byFacility: {
    facilityId: string;
    facilityName: string;
    responses: number;
    nps: number | null;
    avgRating: number | null;
  }[];
}

/**
 * Respuesta al enviar la valoración pública. `googleReviewUrl` solo viene si el
 * inquilino es promotor (NPS >= 9) y el tenant configuró su link de Google.
 */
export interface SubmitReviewResultDto {
  status: 'submitted';
  googleReviewUrl: string | null;
  /**
   * A quien nos puntúa con 9 o 10, su código de referido para que nos
   * recomiende (solo con el programa de referidos encendido).
   */
  referral?: {
    code: string;
    shareUrl: string;
    reward: { type: 'percentage' | 'fixed'; value: number } | null;
    friendReward: { type: 'percentage' | 'fixed'; value: number } | null;
  } | null;
}
