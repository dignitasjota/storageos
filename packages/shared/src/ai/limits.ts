import { z } from 'zod';

/**
 * Asistente IA del panel: clave y modelo de la plataforma (editables desde el
 * panel admin; si no, las variables de entorno) y límite de consultas.
 */

/** Consultas al mes incluidas por tenant y al día por usuario, por defecto. */
export const DEFAULT_AI_MONTHLY_QUERY_LIMIT = 300;
export const DEFAULT_AI_DAILY_USER_LIMIT = 50;
/** Preguntas al día por inquilino en el chatbot del área de clientes. */
export const DEFAULT_AI_PORTAL_DAILY_LIMIT = 20;
/** A partir de qué parte del límite se avisa (80 %). */
export const AI_LIMIT_WARNING_RATIO = 0.8;

/** De dónde sale la clave que se usa: el panel, las variables o ninguna (demo). */
export type AiKeySource = 'panel' | 'env' | 'demo';

export interface PlatformAiSettingsDto {
  source: AiKeySource;
  /** Modelo que se usa ahora. */
  model: string;
  /** Lo guardado en el panel. */
  panelKeyConfigured: boolean;
  panelKeyLast4: string | null;
  panelModel: string | null;
  /** Lo que hay en las variables de entorno (respaldo). */
  envKeyConfigured: boolean;
  envModel: string | null;
  monthlyQueryLimit: number;
  dailyUserLimit: number;
  portalDailyLimit: number;
  updatedAt: string | null;
}

export const UpdatePlatformAiSettingsSchema = z.object({
  /** Clave nueva; `''` la quita (vuelve a las variables de entorno). */
  apiKey: z.string().trim().max(500).optional(),
  /** Modelo; `''` = el de las variables o el de por defecto. */
  model: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]*$/, 'Modelo no válido')
    .optional(),
  monthlyQueryLimit: z.number().int().min(0).max(1_000_000).optional(),
  dailyUserLimit: z.number().int().min(0).max(100_000).optional(),
  portalDailyLimit: z.number().int().min(0).max(100_000).optional(),
});
export type UpdatePlatformAiSettingsInput = z.infer<typeof UpdatePlatformAiSettingsSchema>;

export interface AiConnectionTestDto {
  ok: boolean;
  model: string;
  source: AiKeySource;
  message: string;
}

/** Consumo del asistente IA de un tenant en el mes (hora de Madrid). */
export interface AiUsageDto {
  /** AAAA-MM. */
  month: string;
  used: number;
  /** Límite efectivo: el del tenant o el general + extras. */
  limit: number;
  /** Del límite, cuánto viene de extras contratados. */
  extra: number;
  /** El super admin le puso un límite propio. */
  customLimit: boolean;
  /** Consultas del usuario que pregunta hoy y su tope diario. */
  dailyUsed: number | null;
  dailyLimit: number;
  /** Día en que se reinicia (YYYY-MM-DD, primer día del mes siguiente). */
  resetsOn: string;
}

export const UpdateTenantAiLimitSchema = z.object({
  /** null = el general + extras. */
  monthlyLimit: z.number().int().min(0).max(1_000_000).nullable(),
});
export type UpdateTenantAiLimitInput = z.infer<typeof UpdateTenantAiLimitSchema>;
