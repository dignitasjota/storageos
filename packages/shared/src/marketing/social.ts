import { z } from 'zod';

/**
 * Instagram y Facebook orgánico del tenant (dentro de Web Premium): el tenant
 * pega un token de su Business Manager; cada día se descargan las métricas de
 * su página de Facebook y de la cuenta de Instagram vinculada, y sus
 * publicaciones recientes.
 */

export const SOCIAL_NETWORKS = ['instagram', 'facebook'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const ConnectSocialSchema = z.object({
  accessToken: z.string().trim().min(20, 'Pega el token completo que te da Meta').max(2000),
  /** Página elegida cuando el token da acceso a varias. */
  pageId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, 'Página no válida')
    .optional(),
});
export type ConnectSocialInput = z.infer<typeof ConnectSocialSchema>;

/** Página a la que da acceso el token (para elegir si hay varias). */
export interface SocialPageOptionDto {
  id: string;
  name: string;
  instagramUsername: string | null;
}

export interface SocialSettingsDto {
  connected: boolean;
  /** connected | error */
  status: 'connected' | 'error' | null;
  pageId: string | null;
  pageName: string | null;
  /** Cuenta profesional de Instagram vinculada a la página. */
  instagramUsername: string | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
}

/** Métricas de un día de una red tal como se guardan (null = Meta no la dio). */
export interface SocialDailyInput {
  network: SocialNetwork;
  date: string;
  followers: number | null;
  newFollowers: number | null;
  reach: number | null;
  views: number | null;
  profileViews: number | null;
  websiteClicks: number | null;
  engagements: number | null;
}

export interface SocialPostInput {
  network: SocialNetwork;
  externalId: string;
  publishedAt: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  views: number | null;
}

/** Línea de días vacía: todas las métricas a null. */
export function emptySocialDay(network: SocialNetwork, date: string): SocialDailyInput {
  return {
    network,
    date,
    followers: null,
    newFollowers: null,
    reach: null,
    views: null,
    profileViews: null,
    websiteClicks: null,
    engagements: null,
  };
}
