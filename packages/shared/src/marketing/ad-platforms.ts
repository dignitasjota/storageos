import { z } from 'zod';

/**
 * Sincronización automática de gasto publicitario (Google Ads / Meta Ads):
 * el tenant pega sus propias credenciales (cifradas en BD) — sin flujo OAuth
 * gestionado por la plataforma, ninguna de las dos exige registrar/certificar
 * una app propia. Ver `apps/api/src/modules/marketing/ad-platforms/`.
 */

// --- Google Ads ---

export const UpdateGoogleAdsSettingsSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().trim().min(1).optional(),
  developerToken: z.string().trim().min(1).optional(),
  refreshToken: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  loginCustomerId: z.string().trim().min(1).optional().or(z.literal('')),
  /**
   * Acción de conversión de Google Ads a la que se suman los contratos
   * firmados de quien llegó por un anuncio ('' la quita).
   */
  conversionActionId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, 'Solo cifras')
    .optional()
    .or(z.literal('')),
  enabled: z.boolean(),
});
export type UpdateGoogleAdsSettingsInput = z.infer<typeof UpdateGoogleAdsSettingsSchema>;

export interface GoogleAdsSettingsDto {
  enabled: boolean;
  /** true si las 4 credenciales secretas (client secret, developer token, refresh token) y el customerId están configurados. */
  hasCredentials: boolean;
  customerId: string | null;
  loginCustomerId: string | null;
  conversionActionId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  conversions: AdConversionStatsDto;
}

// --- Meta Ads ---

export const UpdateMetaAdsSettingsSchema = z.object({
  accessToken: z.string().trim().min(1).optional(),
  adAccountId: z.string().trim().min(1).optional(),
  /** Píxel de Meta al que se mandan los contratos firmados ('' lo quita). */
  pixelId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, 'Solo cifras')
    .optional()
    .or(z.literal('')),
  enabled: z.boolean(),
});
export type UpdateMetaAdsSettingsInput = z.infer<typeof UpdateMetaAdsSettingsSchema>;

export interface MetaAdsSettingsDto {
  enabled: boolean;
  hasAccessToken: boolean;
  adAccountId: string | null;
  pixelId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  conversions: AdConversionStatsDto;
}

// --- Común ---

/** Contratos firmados devueltos a la plataforma en los últimos 30 días. */
export interface AdConversionStatsDto {
  sent: number;
  failed: number;
  lastError: string | null;
  lastSentAt: string | null;
}

export interface AdPlatformTestResultDto {
  ok: boolean;
  message: string;
}

export const SyncAdSpendSchema = z.object({
  /** YYYY-MM-DD; por defecto los últimos 7 días. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type SyncAdSpendInput = z.infer<typeof SyncAdSpendSchema>;

export interface SyncAdSpendResultDto {
  /** Días con gasto importado/actualizado. */
  synced: number;
  totalCost: number;
}
