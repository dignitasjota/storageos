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
/**
 * Chat de la web pública del tenant (visitantes anónimos): respuestas al mes
 * por tenant (aparte de las del panel) y por visitante al día, y modelo (uno
 * barato por defecto).
 */
export const DEFAULT_WEB_CHAT_MONTHLY_LIMIT = 300;
export const DEFAULT_WEB_CHAT_VISITOR_DAILY_LIMIT = 15;
/** `feature` de las respuestas del chat de la web en el registro de uso de IA. */
export const WEB_CHAT_AI_FEATURE = 'web_chat';
export const DEFAULT_WEB_CHAT_MODEL = 'claude-haiku-5-5';
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
  /** Chat de la web: modelo que se usa, el guardado y los límites. */
  webModel: string;
  panelWebModel: string | null;
  webMonthlyLimit: number;
  webVisitorDailyLimit: number;
  /** Aviso de gasto del mes (USD); null = sin aviso. */
  monthlyCostAlertUsd: number | null;
  /** Consultas al mes por plan (slug → n). */
  planLimits: Record<string, number>;
  updatedAt: string | null;
}

/** Uso y coste del asistente IA en el mes (panel admin). */
export interface PlatformAiUsageDto {
  /** AAAA-MM. */
  month: string;
  /** Preguntas con la clave de la plataforma y con las claves de los tenants. */
  queries: number;
  ownKeyQueries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Gasto previsto a final de mes al ritmo actual. */
  projectedCostUsd: number;
  alertUsd: number | null;
  overAlert: boolean;
  /** Los tenants que más gastan este mes. */
  topTenants: { tenantId: string; name: string; queries: number; costUsd: number }[];
}

/** Modelos de Claude que se proponen en el panel (se puede escribir otro). */
export const SUGGESTED_AI_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
] as const;

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
  /** Modelo del chat de la web; `''` = el de por defecto. */
  webModel: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]*$/, 'Modelo no válido')
    .optional(),
  webMonthlyLimit: z.number().int().min(0).max(1_000_000).optional(),
  webVisitorDailyLimit: z.number().int().min(0).max(1000).optional(),
  monthlyCostAlertUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  planLimits: z.record(z.string().max(60), z.number().int().min(0).max(1_000_000)).optional(),
});

/** Probar el asistente con una pregunta propia (sin guardar nada). */
export const TestAiPromptSchema = z.object({
  prompt: z.string().trim().max(2000).optional(),
});
export type UpdatePlatformAiSettingsInput = z.infer<typeof UpdatePlatformAiSettingsSchema>;

export interface AiConnectionTestDto {
  ok: boolean;
  model: string;
  source: AiKeySource;
  message: string;
  /** Respuesta del modelo a la pregunta de prueba (si se mandó una). */
  answer?: string | null;
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
  /** Chat de la web pública: respuestas del mes (con la IA de TrasterOS) y su límite. */
  webUsed: number;
  webLimit: number;
  webCustomLimit: boolean;
}

export const AiKeyModeEnum = z.enum(['platform', 'own']);
export type AiKeyMode = z.infer<typeof AiKeyModeEnum>;

export const UpdateTenantAiLimitSchema = z.object({
  /** null = el general + extras; sin enviar = no cambia. */
  monthlyLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** Respuestas al mes del chat de la web (null = el general). */
  webMonthlyLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
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
