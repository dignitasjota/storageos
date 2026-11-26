import { z } from 'zod';

import { seoFmtInt } from './opportunities';

/**
 * SEO Avanzado, PR 8: alertas del proyecto. Reglas sencillas sobre lo que ya
 * se guarda (Search Console, palabras seguidas, diagnóstico y SISTRIX), con
 * umbrales editables por proyecto. Una alerta no se repite mientras siga
 * abierta, se resuelve sola cuando la condición desaparece y se puede
 * silenciar unos días.
 */

export const SEO_ALERT_TYPES = [
  'clicks_drop',
  'position_drop',
  'gsc_stale',
  'gsc_access_lost',
  'private_page',
  'cannibalization',
  'sistrix_reconnect',
  'sistrix_quota',
] as const;
export type SeoAlertType = (typeof SEO_ALERT_TYPES)[number];
export const SeoAlertTypeEnum = z.enum(SEO_ALERT_TYPES);

export const SEO_ALERT_TYPE_LABELS: Record<SeoAlertType, string> = {
  clicks_drop: 'Caída de clics',
  position_drop: 'Una palabra importante baja',
  gsc_stale: 'Google sin datos nuevos',
  gsc_access_lost: 'Sin acceso a Search Console',
  private_page: 'Página privada en Google',
  cannibalization: 'Canibalización importante',
  sistrix_reconnect: 'Hay que volver a conectar SISTRIX',
  sistrix_quota: 'Cuota diaria de SISTRIX agotada',
};

export const SEO_ALERT_SEVERITIES = ['high', 'medium', 'low'] as const;
export type SeoAlertSeverity = (typeof SEO_ALERT_SEVERITIES)[number];
export const SEO_ALERT_SEVERITY_LABELS: Record<SeoAlertSeverity, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

export const SEO_ALERT_STATUSES = ['open', 'silenced', 'resolved'] as const;
export type SeoAlertStatus = (typeof SEO_ALERT_STATUSES)[number];
export const SeoAlertStatusEnum = z.enum(SEO_ALERT_STATUSES);
export const SEO_ALERT_STATUS_LABELS: Record<SeoAlertStatus, string> = {
  open: 'Abierta',
  silenced: 'Silenciada',
  resolved: 'Resuelta',
};

/**
 * Las de SISTRIX ya las avisa su conexión (PR 3): aquí solo entran en la lista
 * del proyecto, sin otro aviso.
 */
export const SEO_ALERT_TYPES_WITHOUT_NOTICE: SeoAlertType[] = [
  'sistrix_reconnect',
  'sistrix_quota',
];

/** Umbrales y reglas activas por defecto (editables por proyecto). */
export const SEO_DEFAULT_ALERT_SETTINGS = {
  /** % de caída de clics del dominio (7 días frente a los 7 anteriores). */
  clicksDropPct: 30,
  /** Clics mínimos en los 7 días anteriores para avisar. */
  clicksDropMinClicks: 20,
  /** Puestos que tiene que bajar una palabra seguida de prioridad alta. */
  positionDropPlaces: 3,
  /** Impresiones mínimas en cada semana para comparar su posición. */
  positionDropMinImpressions: 30,
  /** Días sin datos nuevos de Google para avisar. */
  gscStaleDays: 5,
  /** Días que se silencia una alerta por defecto. */
  silenceDays: 7,
} as const;
export type SeoAlertThresholdKey = keyof typeof SEO_DEFAULT_ALERT_SETTINGS;

export const SEO_ALERT_THRESHOLD_RANGES: Record<
  SeoAlertThresholdKey,
  { min: number; max: number; label: string }
> = {
  clicksDropPct: { min: 10, max: 90, label: 'Caída de clics para avisar (%)' },
  clicksDropMinClicks: { min: 1, max: 100_000, label: 'Clics mínimos de la semana anterior' },
  positionDropPlaces: { min: 1, max: 50, label: 'Puestos que baja una palabra importante' },
  positionDropMinImpressions: { min: 1, max: 100_000, label: 'Impresiones mínimas por semana' },
  gscStaleDays: { min: 3, max: 60, label: 'Días sin datos de Google' },
  silenceDays: { min: 1, max: 90, label: 'Días que se silencia una alerta' },
};

export interface SeoAlertSettings {
  thresholds: Record<SeoAlertThresholdKey, number>;
  /** Reglas apagadas (las demás, activas). */
  disabled: SeoAlertType[];
  /** En el tenant: además de la notificación del panel, correo a quien configura. */
  email: boolean;
}

/** Ajustes guardados con los valores por defecto donde falten. */
export function seoAlertSettingsOf(stored: unknown): SeoAlertSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const raw = (s.thresholds && typeof s.thresholds === 'object' ? s.thresholds : {}) as Record<
    string,
    unknown
  >;
  const thresholds = { ...SEO_DEFAULT_ALERT_SETTINGS } as Record<SeoAlertThresholdKey, number>;
  for (const k of Object.keys(SEO_ALERT_THRESHOLD_RANGES) as SeoAlertThresholdKey[]) {
    const v = raw[k];
    const r = SEO_ALERT_THRESHOLD_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      thresholds[k] = Math.min(r.max, Math.max(r.min, Math.round(v)));
    }
  }
  const disabled = Array.isArray(s.disabled)
    ? (s.disabled.filter((t) =>
        (SEO_ALERT_TYPES as readonly unknown[]).includes(t),
      ) as SeoAlertType[])
    : [];
  return { thresholds, disabled: [...new Set(disabled)], email: s.email === true };
}

export const UpdateSeoAlertSettingsSchema = z
  .object({
    thresholds: z
      .object(
        Object.fromEntries(
          (Object.keys(SEO_ALERT_THRESHOLD_RANGES) as SeoAlertThresholdKey[]).map((k) => [
            k,
            z
              .number()
              .int()
              .min(SEO_ALERT_THRESHOLD_RANGES[k].min)
              .max(SEO_ALERT_THRESHOLD_RANGES[k].max)
              .optional(),
          ]),
        ) as Record<SeoAlertThresholdKey, z.ZodOptional<z.ZodNumber>>,
      )
      .partial()
      .optional(),
    disabled: z.array(SeoAlertTypeEnum).max(SEO_ALERT_TYPES.length).optional(),
    email: z.boolean().optional(),
    /** Vuelve a los valores por defecto. */
    reset: z.boolean().optional(),
  })
  .strict();
export type UpdateSeoAlertSettingsInput = z.infer<typeof UpdateSeoAlertSettingsSchema>;

export const SilenceSeoAlertSchema = z.object({
  days: z.number().int().min(1).max(90).optional(),
});
export type SilenceSeoAlertInput = z.infer<typeof SilenceSeoAlertSchema>;

// --------------------------------------------------------------- reglas

/** Lo que dice una regla que pasa ahora (una alerta que debería estar abierta). */
export interface SeoAlertCandidate {
  type: SeoAlertType;
  /** Clave de deduplicación (estable mientras sea el mismo problema). */
  key: string;
  severity: SeoAlertSeverity;
  title: string;
  message: string;
  data: Record<string, unknown>;
}

const fmtInt = seoFmtInt;
const fmtPos = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const fmtDate = (d: string) => d.split('-').reverse().join('/');

/**
 * Caída de clics de un dominio: los 7 días hasta el último dato frente a los
 * 7 anteriores. Solo con las dos semanas completas (si faltan días, no se
 * compara: se confundiría un retraso de Google con una caída).
 */
export function seoClicksDropAlert(input: {
  domainId: string;
  domain: string;
  to: string;
  current: { clicks: number; days: number };
  previous: { clicks: number; days: number };
  thresholds: Pick<SeoAlertSettings['thresholds'], 'clicksDropPct' | 'clicksDropMinClicks'>;
}): SeoAlertCandidate | null {
  const { current, previous, thresholds: t } = input;
  if (current.days < 7 || previous.days < 7) return null;
  if (previous.clicks < t.clicksDropMinClicks) return null;
  const dropPct = Math.round(((previous.clicks - current.clicks) / previous.clicks) * 1000) / 10;
  if (dropPct < t.clicksDropPct) return null;
  return {
    type: 'clicks_drop',
    key: `clicks_drop|${input.domainId}`,
    severity: dropPct >= 50 ? 'high' : 'medium',
    title: `Los clics desde Google de ${input.domain} han bajado un ${fmtInt(dropPct)} %`,
    message: `Semana hasta el ${fmtDate(input.to)}: ${fmtInt(current.clicks)} clics frente a ${fmtInt(previous.clicks)} la anterior. Mira qué búsquedas y páginas han caído; puede ser temporada.`,
    data: {
      domainId: input.domainId,
      domain: input.domain,
      to: input.to,
      clicks: current.clicks,
      previousClicks: previous.clicks,
      dropPct,
    },
  };
}

/**
 * Una palabra seguida de prioridad alta que baja de posición (7 días frente a
 * los 7 anteriores), con impresiones suficientes en las dos semanas.
 */
export function seoPositionDropAlert(input: {
  domainId: string;
  domain: string;
  keyword: string;
  current: { position: number | null; impressions: number };
  previous: { position: number | null; impressions: number };
  thresholds: Pick<
    SeoAlertSettings['thresholds'],
    'positionDropPlaces' | 'positionDropMinImpressions'
  >;
}): SeoAlertCandidate | null {
  const { current, previous, thresholds: t } = input;
  if (current.position === null || previous.position === null) return null;
  if (
    current.impressions < t.positionDropMinImpressions ||
    previous.impressions < t.positionDropMinImpressions
  ) {
    return null;
  }
  const drop = Math.round((current.position - previous.position) * 10) / 10;
  if (drop < t.positionDropPlaces) return null;
  return {
    type: 'position_drop',
    key: `position_drop|${input.domainId}|${input.keyword}`,
    severity: previous.position <= 10 && current.position > 10 ? 'high' : 'medium',
    title: `«${input.keyword}» baja ${fmtPos(drop)} puestos en Google`,
    message: `Posición media ${fmtPos(current.position)} esta semana frente a ${fmtPos(previous.position)} la anterior (${input.domain}).`,
    data: {
      domainId: input.domainId,
      domain: input.domain,
      keyword: input.keyword,
      position: current.position,
      previousPosition: previous.position,
      drop,
    },
  };
}

/**
 * Search Console: sin acceso a la propiedad (la conexión dio error) o sin
 * datos nuevos desde hace `gscStaleDays` días (con la carga inicial hecha).
 */
export function seoGscFreshnessAlerts(input: {
  domainId: string;
  domain: string;
  connectionStatus: string;
  lastError: string | null;
  dataUntil: string | null;
  initialDone: boolean;
  today: string;
  thresholds: Pick<SeoAlertSettings['thresholds'], 'gscStaleDays'>;
}): SeoAlertCandidate[] {
  if (input.connectionStatus === 'error') {
    return [
      {
        type: 'gsc_access_lost',
        key: `gsc_access_lost|${input.domainId}`,
        severity: 'high',
        title: `Sin acceso a Search Console de ${input.domain}`,
        message: `Google no deja leer los datos${input.lastError ? `: ${input.lastError.slice(0, 200)}` : ''}. Comprueba que la cuenta sigue añadida como usuario en la propiedad.`,
        data: { domainId: input.domainId, domain: input.domain },
      },
    ];
  }
  if (input.connectionStatus !== 'connected' || !input.initialDone || !input.dataUntil) return [];
  const days = Math.round(
    (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${input.dataUntil}T00:00:00Z`)) /
      86_400_000,
  );
  if (days < input.thresholds.gscStaleDays) return [];
  return [
    {
      type: 'gsc_stale',
      key: `gsc_stale|${input.domainId}`,
      severity: days >= input.thresholds.gscStaleDays * 2 ? 'high' : 'medium',
      title: `Google no da datos nuevos de ${input.domain} desde hace ${days} días`,
      message: `El último día con datos es el ${fmtDate(input.dataUntil)}. Google suele ir 2 o 3 días por detrás; más que eso, mira las descargas del proyecto.`,
      data: { domainId: input.domainId, domain: input.domain, dataUntil: input.dataUntil, days },
    },
  ];
}

// -------------------------------------------------------- sincronización

export interface SeoExistingAlert {
  id: string;
  key: string;
  status: SeoAlertStatus;
  /** Hasta cuándo está silenciada (ISO); null si no. */
  silencedUntil: string | null;
}

export interface SeoAlertSyncPlan {
  /** Nuevas: se crean y se avisa (salvo los tipos sin aviso). */
  create: SeoAlertCandidate[];
  /** Siguen pasando: se actualiza su mensaje y cuándo se vio por última vez, sin avisar. */
  touch: { id: string; candidate: SeoAlertCandidate }[];
  /** Silenciadas cuyo plazo acabó y siguen pasando: vuelven a abrirse y se avisa. */
  reopen: { id: string; candidate: SeoAlertCandidate }[];
  /** Ya no pasan: se resuelven solas. */
  resolve: string[];
}

/**
 * Qué hacer con las alertas guardadas (abiertas o silenciadas) a la vista de
 * lo que pasa ahora. Los tipos apagados no cuentan (las suyas se resuelven).
 */
export function planSeoAlertSync(
  existing: readonly SeoExistingAlert[],
  current: readonly SeoAlertCandidate[],
  now: Date,
  disabled: readonly SeoAlertType[] = [],
): SeoAlertSyncPlan {
  const active = new Map<string, SeoAlertCandidate>();
  for (const c of current)
    if (!disabled.includes(c.type) && !active.has(c.key)) active.set(c.key, c);
  const live = existing.filter((e) => e.status !== 'resolved');
  const byKey = new Map(live.map((e) => [e.key, e]));
  const plan: SeoAlertSyncPlan = { create: [], touch: [], reopen: [], resolve: [] };
  for (const [key, candidate] of active) {
    const e = byKey.get(key);
    if (!e) plan.create.push(candidate);
    else if (
      e.status === 'silenced' &&
      e.silencedUntil !== null &&
      Date.parse(e.silencedUntil) <= now.getTime()
    ) {
      plan.reopen.push({ id: e.id, candidate });
    } else plan.touch.push({ id: e.id, candidate });
  }
  for (const e of live) if (!active.has(e.key)) plan.resolve.push(e.id);
  return plan;
}

// ------------------------------------------------------------------- DTOs

export interface SeoProjectAlertDto {
  id: string;
  type: SeoAlertType;
  severity: SeoAlertSeverity;
  title: string;
  message: string;
  data: Record<string, unknown>;
  status: SeoAlertStatus;
  silencedUntil: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** Cómo se resolvió: sola (la condición desapareció) o a mano. */
  resolvedBy: 'auto' | 'manual' | null;
  notifiedAt: string | null;
}

export interface SeoProjectAlertListDto {
  items: SeoProjectAlertDto[];
  /** Abiertas (sin las silenciadas): el contador de la sección. */
  openCount: number;
  silencedCount: number;
  checkedAt: string | null;
  settings: SeoAlertSettings;
}

export const SEO_ALERT_LIST_MAX = 200;
