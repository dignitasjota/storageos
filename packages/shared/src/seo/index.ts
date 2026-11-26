import { z } from 'zod';

import { SEARCH_CONSOLE_SITE_RE, type SeoTotalsDto } from '../web/search-console';

import type { SeoChangeDto, SeoUndetailedDto } from './metrics';
import type { SeoWeights } from './opportunities';

export * from './metrics';
export * from './panel';
export * from './gsc-import';
export * from './sistrix';
export * from './opportunities';
export * from './diagnostics';
export * from './plan';
export * from './master-import';

/**
 * SEO Avanzado: un solo motor para dos ámbitos. Un proyecto sin tenant es de
 * la plataforma (trasteros.pro, panel del super admin); con tenant, es la web
 * de ese negocio (extra «SEO Avanzado», uno por tenant).
 */

/**
 * Cruces de Search Console que se guardan, todos por día. Cada uno se pide a
 * Google por separado, así que nunca se suman entre sí: los totales salen
 * siempre de `site` (cuadran con el panel de Google).
 */
export const SEO_GSC_GRAINS = [
  'site',
  'device',
  'country',
  'search_type',
  'query',
  'page',
  'query_page',
  'query_device',
  'query_country',
  'page_device',
] as const;
export type SeoGscGrain = (typeof SEO_GSC_GRAINS)[number];

/** Dimensiones de la API de Search Console (además de la fecha). */
export type SeoGscDimension = 'query' | 'page' | 'country' | 'device';

/** Qué dimensiones se piden en cada cruce (siempre con `date`). */
export const SEO_GSC_GRAIN_DIMENSIONS: Record<SeoGscGrain, SeoGscDimension[]> = {
  site: [],
  device: ['device'],
  country: ['country'],
  // Una petición por tipo de búsqueda (web, imágenes, vídeos, noticias).
  search_type: [],
  query: ['query'],
  page: ['page'],
  query_page: ['query', 'page'],
  query_device: ['query', 'device'],
  query_country: ['query', 'country'],
  page_device: ['page', 'device'],
};

/** Cruces con pocas filas por día: se piden de una vez para todo el periodo. */
export const SEO_GSC_TOTAL_GRAINS: SeoGscGrain[] = ['site', 'device', 'country', 'search_type'];
/**
 * Cruces con consulta o página: día a día, porque Google limita las filas por
 * petición y, pidiendo el periodo entero, se perdería la cola larga.
 */
export const SEO_GSC_DAILY_GRAINS: SeoGscGrain[] = [
  'query',
  'page',
  'query_page',
  'query_device',
  'query_country',
  'page_device',
];

/** Tipos de búsqueda del cruce `search_type`. El resto de cruces son de la web. */
export const SEO_GSC_SEARCH_TYPES = ['web', 'image', 'video', 'news'] as const;
export type SeoGscSearchType = (typeof SEO_GSC_SEARCH_TYPES)[number];

/** Días que se descargan al conectar un dominio (los 16 meses que guarda Google). */
export const SEO_GSC_INITIAL_DAYS = 486;
/** Días que se repasan cada día: Google corrige los datos recientes. */
export const SEO_GSC_DAILY_DAYS = 5;
/** A partir de estos días sin datos nuevos, el dominio va con retraso. */
export const SEO_GSC_DELAY_DAYS = 4;
/** Cruces grandes que se guardan 25 meses (los demás, sin caducidad). */
export const SEO_GSC_SHORT_RETENTION_GRAINS: SeoGscGrain[] = ['query_page', 'query_country'];
export const SEO_GSC_SHORT_RETENTION_MONTHS = 25;

/** Periodos de comparación del resumen. */
export const SEO_PERIODS = [7, 28, 90] as const;
export type SeoPeriodDays = (typeof SEO_PERIODS)[number];

/** Límites del proyecto de un tenant. */
export const SEO_TENANT_LIMITS = {
  primaryDomains: 1,
  /** Secundarios y redirigidos, juntos. */
  secondaryDomains: 3,
  /** Palabras seguidas (PR posterior). */
  keywords: 300,
  /** Competidores (PR posterior). */
  competitors: 10,
} as const;

export const SeoStrategyEnum = z.enum(['local', 'national', 'international']);
export type SeoStrategy = z.infer<typeof SeoStrategyEnum>;
export const SEO_STRATEGY_LABELS: Record<SeoStrategy, string> = {
  local: 'Local (una ciudad o zona)',
  national: 'Nacional',
  international: 'Internacional',
};

export const SeoDomainRoleEnum = z.enum(['primary', 'secondary', 'redirect']);
export type SeoDomainRole = z.infer<typeof SeoDomainRoleEnum>;
export const SEO_DOMAIN_ROLE_LABELS: Record<SeoDomainRole, string> = {
  primary: 'Principal',
  secondary: 'Secundario',
  redirect: 'Redirigido',
};

export type SeoConnectionStatus = 'pending' | 'connected' | 'error';

/**
 * Cómo se sabe que un dominio es del proyecto: `own` (dominio propio, correo
 * verificado o dirección en la plataforma) o `gsc_access` (un secundario que
 * no es propio, pero la cuenta de servicio tiene acceso a su propiedad de
 * Search Console y no lo usa ningún otro proyecto).
 */
export type SeoDomainVerification = 'own' | 'gsc_access';
export type SeoProjectStatus = 'active' | 'paused';
export type SeoSyncKind = 'initial' | 'daily' | 'manual';
export type SeoSyncStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export const SEO_SYNC_KIND_LABELS: Record<SeoSyncKind, string> = {
  initial: 'Carga inicial',
  daily: 'Diaria',
  manual: 'Manual',
};
export const SEO_SYNC_STATUS_LABELS: Record<SeoSyncStatus, string> = {
  queued: 'En cola',
  running: 'Descargando',
  done: 'Terminada',
  failed: 'Con error',
  cancelled: 'Cancelada',
};

/** Frecuencia de cada proceso. Search Console, cada día a las 07:00. */
export const SEO_DEFAULT_FREQUENCIES = {
  gsc: 'daily',
  opportunities: 'weekly',
  report: 'monthly',
} as const;
export type SeoFrequencies = Record<keyof typeof SEO_DEFAULT_FREQUENCIES, string>;

const brandTerms = z
  .array(z.string().trim().min(2).max(60))
  .max(20)
  .transform((list) => [...new Set(list.map((t) => t.toLowerCase()))]);

export const CreateSeoProjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Código de país de dos letras (ES)')
    .transform((c) => c.toUpperCase())
    .default('ES'),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}$/, 'Código de idioma de dos letras (es)')
    .default('es'),
  businessType: z.string().trim().max(120).nullable().optional(),
  strategy: SeoStrategyEnum.default('local'),
  targetLocation: z.string().trim().max(200).nullable().optional(),
  brandTerms: brandTerms.default([]),
});
export type CreateSeoProjectInput = z.infer<typeof CreateSeoProjectSchema>;

/** El tenant crea su proyecto con un clic: el nombre, si no lo da, el de su negocio. */
export const CreateTenantSeoProjectSchema = CreateSeoProjectSchema.extend({
  name: z.string().trim().min(2).max(120).optional(),
});
export type CreateTenantSeoProjectInput = z.infer<typeof CreateTenantSeoProjectSchema>;
/** Lo que manda el panel (los campos con valor por defecto, opcionales). */
export type CreateTenantSeoProjectRequest = z.input<typeof CreateTenantSeoProjectSchema>;

export const UpdateSeoProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Código de país de dos letras (ES)')
      .transform((c) => c.toUpperCase()),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/, 'Código de idioma de dos letras (es)'),
    businessType: z.string().trim().max(120).nullable(),
    strategy: SeoStrategyEnum,
    targetLocation: z.string().trim().max(200).nullable(),
    brandTerms,
    status: z.enum(['active', 'paused']),
  })
  .partial();
export type UpdateSeoProjectInput = z.infer<typeof UpdateSeoProjectSchema>;

const gscProperty = z
  .string()
  .trim()
  .regex(
    SEARCH_CONSOLE_SITE_RE,
    'Escribe la propiedad tal como sale en Search Console: sc-domain:tudominio.es o https://tudominio.es/',
  );

export const CreateSeoDomainSchema = z.object({
  gscProperty,
  /** Sin indicar: principal si el proyecto aún no tiene, si no, secundario. */
  role: SeoDomainRoleEnum.optional(),
});
export type CreateSeoDomainInput = z.infer<typeof CreateSeoDomainSchema>;

export const UpdateSeoDomainSchema = z.object({ role: SeoDomainRoleEnum });
export type UpdateSeoDomainInput = z.infer<typeof UpdateSeoDomainSchema>;

/**
 * Dominio de una propiedad de Search Console, sin `www.` y en minúsculas:
 * `sc-domain:ejemplo.es` → `ejemplo.es`, `https://www.ejemplo.es/blog/` →
 * `ejemplo.es`. Dos propiedades del mismo dominio son el mismo dominio.
 */
export function seoDomainOfProperty(property: string): string {
  const value = property.trim().toLowerCase();
  const host = value.startsWith('sc-domain:')
    ? value.slice('sc-domain:'.length)
    : value.replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');
  return host.replace(/^www\./, '').replace(/\.$/, '');
}

export interface SeoSyncRunDto {
  id: string;
  projectId: string;
  domainId: string | null;
  domain: string | null;
  provider: 'gsc';
  kind: SeoSyncKind;
  status: SeoSyncStatus;
  daysDone: number;
  daysTotal: number;
  rangeFrom: string | null;
  rangeTo: string | null;
  rows: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Quién la lanzó (null = la tarea automática). */
  createdBy: string | null;
}

export interface SeoProjectDomainDto {
  id: string;
  domain: string;
  role: SeoDomainRole;
  gscProperty: string;
  connectionStatus: SeoConnectionStatus;
  lastError: string | null;
  checkedAt: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  /** Último día con datos de Google (YYYY-MM-DD). */
  dataUntil: string | null;
  /** Días desde el último dato (Google va 2-3 días por detrás). */
  dataDelayDays: number | null;
  /** Va con más retraso del normal (`SEO_GSC_DELAY_DAYS`). */
  delayed: boolean;
  /** Ya terminó la carga de los 16 meses. */
  initialDone: boolean;
  verification: SeoDomainVerification;
  /** Descarga en cola o en curso. */
  activeRun: SeoSyncRunDto | null;
}

export interface SeoProjectDto {
  id: string;
  /** null = proyecto de la plataforma. */
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  name: string;
  country: string;
  language: string;
  businessType: string | null;
  strategy: SeoStrategy;
  targetLocation: string | null;
  brandTerms: string[];
  weights: SeoWeights;
  frequencies: SeoFrequencies;
  status: SeoProjectStatus;
  createdAt: string;
  domains: SeoProjectDomainDto[];
}

/** Lo que ve el tenant en SEO Avanzado (su proyecto, si ya lo creó). */
export interface SeoWorkspaceDto {
  project: SeoProjectDto | null;
  /** La plataforma tiene la cuenta de servicio de Google configurada. */
  available: boolean;
  /** Correo que hay que añadir como usuario en Search Console. */
  serviceAccountEmail: string | null;
  limits: typeof SEO_TENANT_LIMITS;
  /** Dominio de su web (para proponerlo como principal). */
  suggestedProperty: string | null;
}

/** Propiedad de Search Console a la que tiene acceso la cuenta de servicio. */
export interface SeoGscPropertyDto {
  siteUrl: string;
  permissionLevel: string;
  domain: string;
  /** Ya está en un proyecto (de la plataforma o de un tenant). */
  usedBy: string | null;
}

export interface SeoGscPropertiesDto {
  available: boolean;
  serviceAccountEmail: string | null;
  properties: SeoGscPropertyDto[];
}

/** Proyecto de un tenant visto desde el panel admin (solo lectura). */
export interface SeoTenantProjectRowDto {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  name: string;
  status: SeoProjectStatus;
  /** El tenant tiene ahora SEO Avanzado (si no, no se descarga). */
  featureEnabled: boolean;
  domains: { domain: string; role: SeoDomainRole; connectionStatus: SeoConnectionStatus }[];
  lastSyncedAt: string | null;
  dataUntil: string | null;
}

/** Resumen de un dominio en un periodo (desde el cruce `site`). */
export interface SeoSummaryDto {
  projectId: string;
  domainId: string | null;
  domain: string | null;
  days: number;
  /** Último día con datos (el periodo acaba ahí). */
  lastDate: string | null;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  current: SeoTotalsDto;
  /** null si no hay datos de todo el periodo anterior. */
  previous: SeoTotalsDto | null;
  change: SeoChangeDto | null;
  devices: { device: string; totals: SeoTotalsDto; clickShare: number | null }[];
  /** Lo que Google no detalla por búsqueda (total del sitio − suma por búsqueda). */
  undetailed: SeoUndetailedDto | null;
  daily: { date: string; clicks: number; impressions: number }[];
  delayed: boolean;
}
