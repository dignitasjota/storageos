import { z } from 'zod';

/**
 * SEO Avanzado, PR 3: proveedores de datos y SISTRIX.
 *
 * - `gsc`: Search Console (cuenta de servicio, gratis).
 * - `sistrix_mcp`: SISTRIX por MCP con la cuenta de la plataforma (OAuth, sin
 *   créditos, con cuota diaria).
 * - `sistrix_api`: SISTRIX por la API clásica (clave, créditos semanales). La
 *   de la plataforma, desactivada por defecto; la de cada tenant, su clave.
 * - `manual_import`: lo que se sube a mano (Excel, CSV).
 *
 * Cada dato guardado lleva su proveedor y cuándo se obtuvo, y la pantalla lo
 * enseña junto al valor.
 */
export const SEO_PROVIDER_KEYS = ['gsc', 'sistrix_mcp', 'sistrix_api', 'manual_import'] as const;
export type SeoProviderKey = (typeof SEO_PROVIDER_KEYS)[number];
export const SEO_PROVIDER_LABELS: Record<SeoProviderKey, string> = {
  gsc: 'Google Search Console',
  sistrix_mcp: 'SISTRIX (MCP)',
  sistrix_api: 'SISTRIX (API)',
  manual_import: 'Importado',
};

/** Tipos de dato que da SISTRIX. */
export const SEO_SISTRIX_DATA_TYPES = [
  'visibility',
  'serp',
  'domain_keywords',
  'competitors',
  'opportunities',
  'keyword_metrics',
  'backlinks',
  'ai_visibility',
  'keyword_ideas',
] as const;
export type SeoSistrixDataType = (typeof SEO_SISTRIX_DATA_TYPES)[number];
export const SeoSistrixDataTypeEnum = z.enum(SEO_SISTRIX_DATA_TYPES);
export const SEO_SISTRIX_DATA_TYPE_LABELS: Record<SeoSistrixDataType, string> = {
  visibility: 'Visibilidad',
  serp: 'Resultados de Google de tus palabras',
  domain_keywords: 'Palabras de cada dominio',
  competitors: 'Competidores orgánicos',
  opportunities: 'Oportunidades',
  keyword_metrics: 'Volumen, CPC y competencia',
  backlinks: 'Enlaces',
  ai_visibility: 'Visibilidad en IA',
  keyword_ideas: 'Ideas de palabras',
};

export const SEO_SYNC_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'on_demand',
  'off',
] as const;
export type SeoSyncFrequency = (typeof SEO_SYNC_FREQUENCIES)[number];
export const SeoSyncFrequencyEnum = z.enum(SEO_SYNC_FREQUENCIES);
export const SEO_SYNC_FREQUENCY_LABELS: Record<SeoSyncFrequency, string> = {
  daily: 'Cada día',
  weekly: 'Cada semana',
  biweekly: 'Cada 15 días',
  monthly: 'Cada mes',
  on_demand: 'Solo cuando lo pidas',
  off: 'Nunca',
};
/** Días entre dos descargas de cada frecuencia (null = no se programa). */
export const SEO_SYNC_FREQUENCY_DAYS: Record<SeoSyncFrequency, number | null> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  on_demand: null,
  off: null,
};

/** Frecuencias iniciales (Search Console va aparte, cada día). */
export const SEO_SISTRIX_DEFAULT_FREQUENCIES: Record<SeoSistrixDataType, SeoSyncFrequency> = {
  visibility: 'weekly',
  serp: 'weekly',
  domain_keywords: 'biweekly',
  competitors: 'biweekly',
  opportunities: 'biweekly',
  keyword_metrics: 'monthly',
  backlinks: 'monthly',
  ai_visibility: 'monthly',
  keyword_ideas: 'on_demand',
};

/** Días que vale una respuesta guardada, según el tipo de dato. */
export const SEO_SISTRIX_CACHE_DAYS: Record<SeoSistrixDataType, number> = {
  visibility: 6,
  serp: 6,
  domain_keywords: 13,
  competitors: 13,
  opportunities: 13,
  keyword_metrics: 29,
  backlinks: 29,
  ai_visibility: 29,
  keyword_ideas: 6,
};
/** Lo que pide «Sincronizar ahora» reutiliza lo descargado en las últimas horas. */
export const SEO_SISTRIX_MANUAL_CACHE_HOURS = 24;

/** Límites internos por defecto (consultas por día y por tanda, pausa entre llamadas). */
export const SEO_SISTRIX_DEFAULT_LIMITS = {
  maxRequestsPerDay: 300,
  maxRequestsPerBatch: 60,
  pauseMs: 1000,
} as const;

/** Competidores activos de la plataforma (los de un tenant, `SEO_TENANT_LIMITS`). */
export const SEO_PLATFORM_COMPETITOR_LIMIT = 50;
/** Palabras de un proyecto de la plataforma (las de un tenant, `SEO_TENANT_LIMITS`). */
export const SEO_PLATFORM_KEYWORD_LIMIT = 2000;
/** Filas que se piden de las listas (palabras de un dominio, oportunidades…). */
export const SEO_SISTRIX_LIST_LIMIT = 100;

/** Por qué una tanda está en espera. */
export type SeoSistrixWaitReason =
  | 'mcp_quota'
  | 'mcp_needs_reauth'
  | 'not_connected'
  | 'api_budget'
  | 'api_not_authorized'
  | 'daily_limit'
  | 'not_supported';
export const SEO_SISTRIX_WAIT_LABELS: Record<SeoSistrixWaitReason, string> = {
  mcp_quota: 'SISTRIX agotó la cuota del día; sigue sola mañana',
  mcp_needs_reauth: 'Hay que volver a conectar SISTRIX',
  not_connected: 'SISTRIX no está conectado',
  api_budget: 'Se llegó al presupuesto semanal de créditos',
  api_not_authorized: 'Falta autorizar el uso de la API',
  daily_limit: 'Se llegó al máximo de consultas del día',
  not_supported: 'Este dato no se puede pedir por esta vía',
};

export type SeoSistrixConnectionStatus = 'disconnected' | 'connected' | 'needs_reauth' | 'error';
export const SEO_SISTRIX_CONNECTION_LABELS: Record<SeoSistrixConnectionStatus, string> = {
  disconnected: 'Sin conectar',
  connected: 'Conectado',
  needs_reauth: 'Hay que volver a conectar',
  error: 'Con error',
};

export type SeoSistrixRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled';
export const SEO_SISTRIX_RUN_STATUS_LABELS: Record<SeoSistrixRunStatus, string> = {
  queued: 'En cola',
  running: 'Descargando',
  waiting: 'En espera',
  done: 'Terminada',
  failed: 'Con error',
  cancelled: 'Cancelada',
};

/** Prioridad de una palabra del proyecto. */
export const SEO_KEYWORD_PRIORITY_LABELS: Record<number, string> = {
  1: 'Alta',
  2: 'Media',
  3: 'Baja',
};
export const SeoKeywordIntentEnum = z.enum(['know', 'do', 'visit', 'website']);
export type SeoKeywordIntent = z.infer<typeof SeoKeywordIntentEnum>;
export const SEO_KEYWORD_INTENT_LABELS: Record<SeoKeywordIntent, string> = {
  know: 'Informarse',
  do: 'Contratar o comprar',
  visit: 'Ir a un sitio',
  website: 'Buscar una web',
};

// ---------------------------------------------------------------- utilidades

/** Palabra normalizada: minúsculas, sin espacios de más (con tildes). */
export function normalizeSeoKeyword(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const HOST_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Dominio de un competidor sin protocolo, ruta ni `www.` (null si no vale). */
export function normalizeSeoDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return HOST_RE.test(host) ? host : null;
}

/** Fecha y hora en Madrid de un instante (año, mes, día, hora, minuto, día de la semana). */
function madridParts(at: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    /** 0 = lunes. */
    weekday: weekdays.indexOf(get('weekday')),
  };
}

/** Día de hoy en Madrid (YYYY-MM-DD). */
export function madridToday(at: Date = new Date()): string {
  return madridParts(at).date;
}

/** Instante UTC de una hora de Madrid en un día dado (tiene en cuenta el cambio de hora). */
export function madridInstant(date: string, hour: number, minute = 0): Date {
  const guess = new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  // Dos pasadas: la diferencia con Madrid es de 1 o 2 horas.
  let t = guess.getTime();
  for (let i = 0; i < 2; i++) {
    const p = madridParts(new Date(t));
    const shown = Date.UTC(
      Number(p.date.slice(0, 4)),
      Number(p.date.slice(5, 7)) - 1,
      Number(p.date.slice(8, 10)),
      p.hour,
      p.minute,
    );
    t += guess.getTime() - shown;
  }
  return new Date(t);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Cuándo se reanuda el MCP tras agotar la cuota diaria (error 7010): al día
 * siguiente a las 00:05 de Madrid.
 */
export function sistrixQuotaResetAt(at: Date = new Date()): Date {
  return madridInstant(addDays(madridParts(at).date, 1), 0, 5);
}

/** Lunes (YYYY-MM-DD) de la semana de créditos de la API (lunes 00:00 de Madrid). */
export function sistrixWeekStart(at: Date = new Date()): string {
  const p = madridParts(at);
  return addDays(p.date, -p.weekday);
}

// ------------------------------------------------------------------ esquemas

const frequencies = z.object(
  Object.fromEntries(SEO_SISTRIX_DATA_TYPES.map((t) => [t, SeoSyncFrequencyEnum.optional()])) as {
    [K in SeoSistrixDataType]: z.ZodOptional<typeof SeoSyncFrequencyEnum>;
  },
);

export const UpdateSeoSyncSettingsSchema = z.object({
  frequencies: frequencies.optional(),
  maxRequestsPerDay: z.number().int().min(1).max(5000).optional(),
  maxRequestsPerBatch: z.number().int().min(1).max(1000).optional(),
  pauseMs: z.number().int().min(0).max(60_000).optional(),
});
export type UpdateSeoSyncSettingsInput = z.infer<typeof UpdateSeoSyncSettingsSchema>;

/** Clave de la API clásica: `''` la borra; sin enviar, no se toca. */
export const UpdateSistrixApiSettingsSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .max(200)
    .refine(
      (v) => v === '' || /^[A-Za-z0-9_-]{8,200}$/.test(v),
      'La clave no tiene el formato de SISTRIX',
    )
    .optional(),
  enabled: z.boolean().optional(),
  weeklyBudget: z.number().int().min(0).max(1_000_000).optional(),
});
export type UpdateSistrixApiSettingsInput = z.infer<typeof UpdateSistrixApiSettingsSchema>;

export const SetProjectPlatformSistrixSchema = z.object({ usePlatformSistrix: z.boolean() });
export type SetProjectPlatformSistrixInput = z.infer<typeof SetProjectPlatformSistrixSchema>;

export const SeoSistrixSyncSchema = z.object({ dataType: SeoSistrixDataTypeEnum });
export type SeoSistrixSyncInput = z.infer<typeof SeoSistrixSyncSchema>;

const domainField = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .transform((v, ctx) => {
    const d = normalizeSeoDomain(v);
    if (!d) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Escribe un dominio, p. ej. competidor.es',
      });
      return z.NEVER;
    }
    return d;
  });

export const CreateSeoCompetitorSchema = z.object({
  domain: domainField,
  name: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CreateSeoCompetitorInput = z.infer<typeof CreateSeoCompetitorSchema>;

export const UpdateSeoCompetitorSchema = z
  .object({
    name: z.string().trim().max(120).nullable(),
    notes: z.string().trim().max(1000).nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateSeoCompetitorInput = z.infer<typeof UpdateSeoCompetitorSchema>;

export const SeoKeywordSourceEnum = z.enum([
  'manual',
  'sistrix_ideas',
  'sistrix_opportunities',
  'import',
]);
export type SeoKeywordSource = z.infer<typeof SeoKeywordSourceEnum>;

export const AddSeoProjectKeywordsSchema = z.object({
  keywords: z
    .array(z.string().trim().min(2).max(120))
    .min(1)
    .max(100)
    .transform((list) => [...new Set(list.map(normalizeSeoKeyword))].filter((k) => k.length >= 2)),
  groupName: z.string().trim().max(80).nullable().optional(),
  priority: z.number().int().min(1).max(3).optional(),
  source: SeoKeywordSourceEnum.exclude(['import']).default('manual'),
});
export type AddSeoProjectKeywordsInput = z.infer<typeof AddSeoProjectKeywordsSchema>;

export const UpdateSeoProjectKeywordSchema = z
  .object({
    groupName: z.string().trim().max(80).nullable(),
    intent: SeoKeywordIntentEnum.nullable(),
    targetUrl: z.string().trim().url().max(500).nullable(),
    priority: z.number().int().min(1).max(3),
    notes: z.string().trim().max(1000).nullable(),
    strategyLocked: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateSeoProjectKeywordInput = z.infer<typeof UpdateSeoProjectKeywordSchema>;

// ---------------------------------------------------------------------- DTOs

/** Origen y fecha de un dato (se enseña junto al valor). */
export interface SeoDataOriginDto {
  provider: SeoProviderKey;
  /** Cuándo lo obtuvimos. */
  fetchedAt: string;
  /** Fecha del dato según SISTRIX (semana de la visibilidad, día de la muestra). */
  dataDate: string | null;
}

export interface SeoSistrixToolDto {
  name: string;
  description: string;
  views: string[];
}

export interface SeoSistrixToolChangesDto {
  removedTools: string[];
  addedTools: string[];
  removedViews: { tool: string; view: string }[];
  /** Herramientas o vistas que usamos y ya no están. */
  affectsUs: boolean;
}

export interface SeoSistrixMcpDto {
  status: SeoSistrixConnectionStatus;
  connectedAt: string | null;
  connectedBy: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  tokenExpiresAt: string | null;
  /** Cuota del día agotada (error 7010) hasta esta hora. */
  quotaExhaustedUntil: string | null;
  tools: SeoSistrixToolDto[];
  toolsCheckedAt: string | null;
  toolsChangedAt: string | null;
  toolsChanges: SeoSistrixToolChangesDto | null;
  /** Dirección de vuelta que hay que dejar en SISTRIX (la del API). */
  redirectUri: string;
}

export interface SeoSistrixApiDto {
  enabled: boolean;
  hasKey: boolean;
  /** Últimos 4 caracteres de la clave (la clave nunca vuelve al navegador). */
  keyLast4: string | null;
  weeklyBudget: number;
  weekStart: string | null;
  weekSpent: number;
  creditsBalance: number | null;
  creditsCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Plataforma: «Continuar por API» autorizado hasta esta hora. */
  authorizedUntil: string | null;
}

export interface SeoSyncSettingsDto {
  frequencies: Record<SeoSistrixDataType, SeoSyncFrequency>;
  maxRequestsPerDay: number;
  maxRequestsPerBatch: number;
  pauseMs: number;
  /** Consultas hechas hoy (hora de Madrid). */
  requestsToday: number;
}

export interface SeoSistrixRunDto {
  id: string;
  projectId: string;
  projectName: string | null;
  dataType: SeoSistrixDataType;
  provider: SeoProviderKey | null;
  kind: 'manual' | 'scheduled';
  status: SeoSistrixRunStatus;
  itemsTotal: number;
  itemsDone: number;
  itemsFailed: number;
  pausedReason: SeoSistrixWaitReason | null;
  pausedUntil: string | null;
  creditsUsed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

/** Qué proveedor se usaría ahora mismo (o por qué se espera). */
export interface SeoSistrixRoutingDto {
  provider: SeoProviderKey | null;
  waitReason: SeoSistrixWaitReason | null;
}

/** Panel admin → SEO → Integraciones. */
export interface SeoSistrixIntegrationsDto {
  mcp: SeoSistrixMcpDto;
  api: SeoSistrixApiDto;
  settings: SeoSyncSettingsDto;
  routing: SeoSistrixRoutingDto;
  /** El MCP no puede seguir y la API está lista: se ofrece «Continuar por API». */
  canContinueByApi: boolean;
  /** Tandas en cola, en curso o en espera (de todos los proyectos de la plataforma). */
  pending: SeoSistrixRunDto[];
}

export interface SeoSistrixRequestDto {
  id: string;
  provider: SeoProviderKey;
  tool: string;
  view: string | null;
  args: Record<string, unknown>;
  status: 'ok' | 'empty' | 'error' | 'quota' | 'cached';
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  credits: number;
  projectId: string | null;
  projectName: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SeoSistrixRequestsPageDto {
  items: SeoSistrixRequestDto[];
  nextCursor: string | null;
}

/** Estado de SISTRIX en un proyecto (lo ven el tenant y el super admin). */
export interface SeoSistrixWorkspaceDto {
  projectId: string;
  /** De dónde salen los datos: la conexión de la plataforma o la clave del tenant. */
  pool: 'platform' | 'tenant';
  usePlatformSistrix: boolean;
  /** Se puede pedir algo a SISTRIX ahora mismo o más tarde (hay conexión). */
  available: boolean;
  /** Si no hay ninguna vía: por qué (sin clave, desconectado…). */
  unavailableReason: string | null;
  routing: SeoSistrixRoutingDto;
  lastSync: Partial<Record<SeoSistrixDataType, { at: string; status: SeoSistrixRunStatus }>>;
  frequencies: Record<SeoSistrixDataType, SeoSyncFrequency>;
  limits: { competitors: number; keywords: number };
  counts: { competitors: number; keywords: number };
  runs: SeoSistrixRunDto[];
}

export interface SeoVisibilityPointDto {
  date: string;
  value: number;
  provider: SeoProviderKey;
}

export interface SeoVisibilitySeriesDto {
  domain: string;
  /** Dominio del proyecto (no de un competidor). */
  own: boolean;
  points: SeoVisibilityPointDto[];
  latest: (SeoDataOriginDto & { value: number }) | null;
}

export interface SeoCompetitorDto {
  id: string;
  domain: string;
  name: string | null;
  notes: string | null;
  isActive: boolean;
  source: 'manual' | 'discovered';
  createdAt: string;
  visibility: (SeoDataOriginDto & { value: number }) | null;
  keywordCount: number | null;
}

export interface SeoDomainKeywordDto {
  keyword: string;
  position: number;
  url: string;
  /** Posición en la muestra anterior (null = no aparecía). */
  previousPosition: number | null;
}

export interface SeoDomainKeywordsDto {
  domain: string;
  origin: SeoDataOriginDto | null;
  previousDate: string | null;
  items: SeoDomainKeywordDto[];
}

export interface SeoDomainKeywordHistoryDto {
  domain: string;
  keyword: string;
  points: { date: string; position: number; url: string; provider: SeoProviderKey }[];
}

export interface SeoKeywordMetricsDto extends SeoDataOriginDto {
  traffic: number | null;
  clicks: number | null;
  cpc: number | null;
  competition: number | null;
  intent: { know: number | null; do: number | null; visit: number | null; website: number | null };
  mobileShare: number | null;
}

export interface SeoProjectKeywordDto {
  id: string;
  keyword: string;
  country: string;
  groupName: string | null;
  intent: SeoKeywordIntent | null;
  targetUrl: string | null;
  priority: number;
  notes: string | null;
  strategyLocked: boolean;
  source: SeoKeywordSource;
  isActive: boolean;
  createdAt: string;
  metrics: SeoKeywordMetricsDto | null;
  serp:
    | (SeoDataOriginDto & {
        ownPosition: number | null;
        ownUrl: string | null;
        competitors: number;
      })
    | null;
}

export interface SeoSerpResultDto {
  position: number;
  domain: string;
  url: string;
  own: boolean;
  competitor: boolean;
}

export interface SeoSerpDto {
  keyword: string;
  origin: SeoDataOriginDto | null;
  results: SeoSerpResultDto[];
}

export interface SeoOpportunityDto {
  keyword: string;
  position: number | null;
  url: string | null;
  gain: number | null;
  competition: number | null;
  traffic: number | null;
  /** Ya está en las palabras del proyecto. */
  inProject: boolean;
}

export interface SeoOpportunitiesDto {
  domain: string | null;
  kind: 'opportunity' | 'idea';
  origin: SeoDataOriginDto | null;
  items: SeoOpportunityDto[];
}

export interface SeoBacklinksDto {
  domain: string | null;
  origin: SeoDataOriginDto | null;
  items: { url: string; links: number; domains: number; hosts: number }[];
}

export interface SeoAiVisibilityRowDto extends SeoDataOriginDto {
  domain: string;
  own: boolean;
  promptCount: number;
  models: { model: string; promptCount: number }[];
}

/** Lo que ve el tenant de su conexión de SISTRIX (su clave de API). */
export interface SeoTenantSistrixDto {
  /** El super admin le dio la conexión de la plataforma. */
  usingPlatform: boolean;
  api: Omit<SeoSistrixApiDto, 'authorizedUntil'>;
  settings: SeoSyncSettingsDto;
}

export interface SeoSistrixTestResultDto {
  ok: boolean;
  message: string;
  provider: SeoProviderKey;
  credits?: number | null;
}
