import { z } from 'zod';

import { seoLandingKey } from './conversions';

/**
 * SEO Avanzado, PR 12: Google Analytics 4 del tráfico orgánico de Google por
 * página de entrada. Lo puro: la propiedad, el filtro de la Data API, la
 * normalización de la página (la misma clave que las conversiones de la PR 8)
 * y el cruce con Search Console y con las conversiones propias.
 *
 * GA4 y Search Console miden cosas distintas: un clic en Google no siempre es
 * una sesión (bloqueadores, cookies rechazadas, varias pestañas) y GA4 solo
 * cuenta a quien acepta las cookies de analítica. Las pantallas lo dicen.
 */

/** Días que se descargan al conectar (los 16 meses, como Search Console). */
export const SEO_GA4_INITIAL_DAYS = 486;
/** Días que se repasan cada día (GA4 termina de procesar 1-2 días después). */
export const SEO_GA4_DAILY_DAYS = 6;
/** Filas por página de la tabla cruzada. */
export const SEO_GA4_PAGES_MAX = 200;

/**
 * Filtro de la Data API: solo el tráfico orgánico de Google (grupo de canales
 * por defecto «Organic Search» y fuente `google`). Sin Bing, Ecosia ni el
 * tráfico de anuncios.
 */
export const SEO_GA4_ORGANIC_FILTER = {
  andGroup: {
    expressions: [
      {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      {
        filter: {
          fieldName: 'sessionSource',
          stringFilter: { matchType: 'EXACT', value: 'google', caseSensitive: false },
        },
      },
    ],
  },
} as const;

/** Dimensiones y métricas que se piden (en este orden). */
export const SEO_GA4_DIMENSIONS = ['date', 'hostName', 'landingPagePlusQueryString'] as const;
export const SEO_GA4_METRICS = [
  'sessions',
  'totalUsers',
  'engagedSessions',
  'averageSessionDuration',
  'screenPageViews',
  'keyEvents',
] as const;

/** `properties/123` o `123` → `123`; null si no es un ID de propiedad. */
export function seoGa4PropertyId(raw: string): string | null {
  const v = raw.trim().replace(/^properties\//i, '');
  return /^\d{6,15}$/.test(v) ? v : null;
}

const propertyId = z
  .string()
  .trim()
  .max(40)
  .refine((v) => seoGa4PropertyId(v) !== null, {
    message:
      'Es el número de la propiedad (Administrar → Detalles de la propiedad), p. ej. 123456789.',
  })
  .transform((v) => seoGa4PropertyId(v)!);

/** Conectar GA4: una propiedad propia o la que el tenant ya tiene en Marketing. */
export const ConnectSeoGa4Schema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('own'), propertyId }),
  z.object({ source: z.literal('marketing') }),
]);
export type ConnectSeoGa4Input = z.infer<typeof ConnectSeoGa4Schema>;

export type SeoGa4Source = 'own' | 'marketing';
export type SeoGa4Status = 'pending' | 'connected' | 'error';

export interface SeoGa4SettingsDto {
  /** La cuenta de servicio de Google está configurada en la plataforma. */
  available: boolean;
  /** Correo que hay que añadir como «Lector» en la propiedad de GA4. */
  serviceAccountEmail: string | null;
  propertyId: string | null;
  source: SeoGa4Source | null;
  status: SeoGa4Status | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  /** Ya terminó la carga de los 16 meses. */
  initialDone: boolean;
  /** Primer y último día con datos descargados. */
  dataFrom: string | null;
  dataUntil: string | null;
  /**
   * Solo en el proyecto de un tenant: la conexión de GA4 de Marketing (Web
   * Premium), para reutilizarla en vez de pedir otra vez la propiedad.
   */
  marketing: { connected: boolean; propertyId: string | null } | null;
}

/** Una fila descargada de GA4 (página de entrada y día). */
export interface SeoGa4LandingRowInput {
  date: string;
  /** Host sin `www.` ('' si no se sabe). */
  host: string;
  /** La página de entrada tal como la da GA4 (ruta y parámetros). */
  landing: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  /** Duración media de la sesión en segundos (la de GA4). */
  averageSessionDuration: number;
  pageViews: number;
  keyEvents: number;
}

/** Lo que se guarda: la página normalizada y la duración total (para poder sumar). */
export interface SeoGa4StoredRow {
  date: string;
  host: string;
  landingPath: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  durationSeconds: number;
  pageViews: number;
  keyEvents: number;
}

const hostOf = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
    .slice(0, 255);

/**
 * Normaliza lo que da GA4: la página de entrada con la misma clave que las
 * conversiones (`seoLandingKey`: sin parámetros, sin barra final ni la ruta
 * `/s/<negocio>`), el host sin `www.` y la duración como total. Las filas que
 * acaban en la misma página y día (p. ej. `/precios?utm=…` y `/precios`) se
 * suman. «(not set)» y vacías quedan como `''` (no se sabe).
 */
export function normalizeSeoGa4Rows(
  rows: readonly SeoGa4LandingRowInput[],
  /** Proyecto de la plataforma: `/s/<negocio>` no se suma a las páginas propias. */
  keepBusinessPrefix = false,
): SeoGa4StoredRow[] {
  const out = new Map<string, SeoGa4StoredRow>();
  for (const r of rows) {
    const raw = r.landing.trim();
    const landingPath = !raw || raw === '(not set)' ? '' : seoLandingKey(raw, keepBusinessPrefix);
    const host = r.host === '(not set)' ? '' : hostOf(r.host);
    const key = `${r.date}|${host}|${landingPath}`;
    const prev = out.get(key) ?? {
      date: r.date,
      host,
      landingPath,
      sessions: 0,
      users: 0,
      engagedSessions: 0,
      durationSeconds: 0,
      pageViews: 0,
      keyEvents: 0,
    };
    const sessions = Math.max(0, Math.round(r.sessions));
    prev.sessions += sessions;
    prev.users += Math.max(0, Math.round(r.users));
    prev.engagedSessions += Math.max(0, Math.round(r.engagedSessions));
    prev.durationSeconds += Math.max(0, r.averageSessionDuration) * sessions;
    prev.pageViews += Math.max(0, Math.round(r.pageViews));
    prev.keyEvents += Math.max(0, r.keyEvents);
    out.set(key, prev);
  }
  return [...out.values()];
}

// -------------------------------------------------------------- cifras

/** Sumas de GA4 de un grupo de filas. */
export interface SeoGa4Sums {
  sessions: number;
  users: number;
  engagedSessions: number;
  durationSeconds: number;
  pageViews: number;
  keyEvents: number;
}

export interface SeoGa4MetricsDto {
  sessions: number;
  /**
   * Usuarios: suma de los de cada día (alguien que vuelve otro día cuenta dos
   * veces; GA4 no deja sumar usuarios únicos entre días).
   */
  users: number;
  engagedSessions: number;
  /** Sesiones con interacción ÷ sesiones (0–1); null sin sesiones. */
  engagementRate: number | null;
  /** Segundos. */
  averageSessionDuration: number | null;
  pagesPerSession: number | null;
  /** Eventos clave (conversiones) de GA4. */
  keyEvents: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function seoGa4Metrics(s: SeoGa4Sums): SeoGa4MetricsDto {
  const has = s.sessions > 0;
  return {
    sessions: s.sessions,
    users: s.users,
    engagedSessions: s.engagedSessions,
    engagementRate: has ? Math.round((s.engagedSessions / s.sessions) * 1000) / 1000 : null,
    averageSessionDuration: has ? Math.round(s.durationSeconds / s.sessions) : null,
    pagesPerSession: has ? r2(s.pageViews / s.sessions) : null,
    keyEvents: r2(s.keyEvents),
  };
}

// --------------------------------------------------------------- cruce

/** Search Console de una página en el periodo (clave: `seoPageLandingKey`). */
export interface SeoCrossGscRow {
  landing: string;
  clicks: number;
  impressions: number;
  /** Σ posición × impresiones (para la posición media ponderada). */
  weightedPosition: number;
}

export interface SeoCrossGa4Row extends SeoGa4Sums {
  landing: string;
}

export interface SeoCrossConversionRow {
  landing: string;
  conversions: number;
}

/** Una página de entrada con lo de las tres fuentes. */
export interface SeoPagePerformanceRowDto {
  /** Ruta normalizada ('' = no se sabe cuál fue la primera página). */
  landing: string;
  gsc: { clicks: number; impressions: number; ctr: number | null; position: number | null } | null;
  ga4: SeoGa4MetricsDto | null;
  /** Conversiones propias principales desde Google (PR 8: reservas, contactos o altas). */
  conversions: number;
  /** Conversiones propias ÷ sesiones de GA4 (0–1); null sin sesiones. */
  conversionsPerSession: number | null;
}

export const SEO_PAGE_PERFORMANCE_SORTS = [
  'clicks',
  'impressions',
  'sessions',
  'engagement',
  'conversions',
] as const;
export type SeoPagePerformanceSort = (typeof SEO_PAGE_PERFORMANCE_SORTS)[number];

/**
 * Cruza por página de entrada Search Console (clics, impresiones y posición),
 * GA4 (sesiones e interacción) y las conversiones propias. Las tres fuentes se
 * casan por la misma clave normalizada; una página que solo sale en una de
 * ellas aparece con las otras vacías (null), nunca a cero inventado.
 */
export function crossSeoPagePerformance(input: {
  gsc: readonly SeoCrossGscRow[];
  ga4: readonly SeoCrossGa4Row[];
  conversions: readonly SeoCrossConversionRow[];
  sort?: SeoPagePerformanceSort;
  limit?: number;
}): SeoPagePerformanceRowDto[] {
  type Acc = {
    gsc: { c: number; i: number; w: number } | null;
    ga4: SeoGa4Sums | null;
    conv: number;
  };
  const byKey = new Map<string, Acc>();
  const get = (k: string) => {
    let a = byKey.get(k);
    if (!a) {
      a = { gsc: null, ga4: null, conv: 0 };
      byKey.set(k, a);
    }
    return a;
  };
  for (const g of input.gsc) {
    const a = get(g.landing);
    a.gsc = a.gsc ?? { c: 0, i: 0, w: 0 };
    a.gsc.c += g.clicks;
    a.gsc.i += g.impressions;
    a.gsc.w += g.weightedPosition;
  }
  for (const r of input.ga4) {
    const a = get(r.landing);
    a.ga4 = a.ga4 ?? {
      sessions: 0,
      users: 0,
      engagedSessions: 0,
      durationSeconds: 0,
      pageViews: 0,
      keyEvents: 0,
    };
    a.ga4.sessions += r.sessions;
    a.ga4.users += r.users;
    a.ga4.engagedSessions += r.engagedSessions;
    a.ga4.durationSeconds += r.durationSeconds;
    a.ga4.pageViews += r.pageViews;
    a.ga4.keyEvents += r.keyEvents;
  }
  for (const c of input.conversions) get(c.landing).conv += c.conversions;

  const rows: SeoPagePerformanceRowDto[] = [...byKey.entries()].map(([landing, a]) => {
    const ga4 = a.ga4 ? seoGa4Metrics(a.ga4) : null;
    return {
      landing,
      gsc: a.gsc
        ? {
            clicks: Math.round(a.gsc.c),
            impressions: Math.round(a.gsc.i),
            ctr: a.gsc.i > 0 ? Math.round((a.gsc.c / a.gsc.i) * 10000) / 10000 : null,
            position: a.gsc.i > 0 ? Math.round((a.gsc.w / a.gsc.i) * 10) / 10 : null,
          }
        : null,
      ga4,
      conversions: a.conv,
      conversionsPerSession:
        ga4 && ga4.sessions > 0 ? Math.round((a.conv / ga4.sessions) * 10000) / 10000 : null,
    };
  });
  const sort = input.sort ?? 'clicks';
  const value = (r: SeoPagePerformanceRowDto): number => {
    switch (sort) {
      case 'impressions':
        return r.gsc?.impressions ?? -1;
      case 'sessions':
        return r.ga4?.sessions ?? -1;
      case 'engagement':
        // Las que más tráfico tienen y menos interacción, primero.
        return r.ga4 && r.ga4.engagementRate !== null
          ? r.ga4.sessions * (1 - r.ga4.engagementRate)
          : -1;
      case 'conversions':
        return r.conversions;
      default:
        return r.gsc?.clicks ?? -1;
    }
  };
  rows.sort(
    (a, b) =>
      value(b) - value(a) ||
      (b.gsc?.clicks ?? 0) - (a.gsc?.clicks ?? 0) ||
      a.landing.localeCompare(b.landing),
  );
  return rows.slice(0, input.limit ?? SEO_GA4_PAGES_MAX);
}

export interface SeoGa4PagesDto {
  connected: boolean;
  period: string;
  from: string;
  to: string;
  /** Último día con datos de Search Console y de GA4. */
  gscUntil: string | null;
  ga4Until: string | null;
  /** Totales del periodo (todas las páginas). */
  totals: {
    gscClicks: number;
    ga4: SeoGa4MetricsDto | null;
    conversions: number;
  };
  items: SeoPagePerformanceRowDto[];
}

/** Las cifras de GA4 de una página (ficha de la página o de la palabra). */
export interface SeoGa4PageDetailDto {
  connected: boolean;
  landing: string;
  from: string;
  to: string;
  metrics: SeoGa4MetricsDto | null;
  daily: { date: string; sessions: number; engagedSessions: number }[];
}
