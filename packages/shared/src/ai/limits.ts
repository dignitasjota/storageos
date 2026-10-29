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
  /** platform = la IA de TrasterOS (con límite); own = siempre su clave. */
  mode: AiKeyMode;
  /** Tiene su propia clave (se usa sola al gastar las consultas del mes). */
  ownKeyConfigured: boolean;
  /** Consultas del mes hechas con su propia clave (no cuentan para el límite). */
  ownQueries: number;
}

export const AiKeyModeEnum = z.enum(['platform', 'own']);
export type AiKeyMode = z.infer<typeof AiKeyModeEnum>;

export const UpdateTenantAiLimitSchema = z.object({
  /** null = el general + extras; sin enviar = no cambia. */
  monthlyLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  mode: AiKeyModeEnum.optional(),
});
export type UpdateTenantAiLimitInput = z.infer<typeof UpdateTenantAiLimitSchema>;

/** Clave propia del tenant para el asistente del panel (Configuración → Asistente IA). */
export interface TenantAiSettingsDto {
  mode: AiKeyMode;
  ownKeyConfigured: boolean;
  ownKeyLast4: string | null;
  ownModel: string | null;
  /** Modelo que se usa con su clave si no pone otro. */
  defaultModel: string;
}

export const UpdateTenantAiSettingsSchema = z.object({
  /** Clave de Anthropic; `''` la quita. */
  apiKey: z.string().trim().max(500).optional(),
  model: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]*$/, 'Modelo no válido')
    .optional(),
});
export type UpdateTenantAiSettingsInput = z.infer<typeof UpdateTenantAiSettingsSchema>;

/** Resultado de probar la clave propia del tenant. */
export interface TenantAiTestDto {
  ok: boolean;
  model: string;
  message: string;
}
