import { z } from 'zod';

import { shiftDate, type SeoTotalsDto } from '../web/search-console';

import { SEO_ALERT_TYPE_LABELS, type SeoAlertSeverity, type SeoAlertType } from './alerts';
import { SEO_CONVERSION_TYPE_LABELS, type SeoConversionType } from './conversions';
import { seoFmtInt } from './opportunities';

import type { SeoChangeDto } from './metrics';

/**
 * SEO Avanzado, PR 8: informes semanal y mensual del proyecto (§7 y §12,
 * fase 3). El semanal sale los lunes a las 09:00 y el mensual el día 3 a las
 * 09:00 (hora de España), por correo con el PDF y en el panel.
 */

export const SEO_REPORT_KINDS = ['weekly', 'monthly'] as const;
export type SeoReportKind = (typeof SEO_REPORT_KINDS)[number];
export const SeoReportKindEnum = z.enum(SEO_REPORT_KINDS);
export const SEO_REPORT_KIND_LABELS: Record<SeoReportKind, string> = {
  weekly: 'Semanal',
  monthly: 'Mensual',
};

export const SEO_REPORT_STATUSES = ['sending', 'sent', 'empty', 'failed'] as const;
export type SeoReportStatus = (typeof SEO_REPORT_STATUSES)[number];
export const SEO_REPORT_STATUS_LABELS: Record<SeoReportStatus, string> = {
  sending: 'Enviándose',
  sent: 'Enviado',
  empty: 'Sin destinatarios',
  failed: 'Falló',
};

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const fmtDate = (d: string) => d.split('-').reverse().join('/');

export interface SeoReportPeriod {
  kind: SeoReportKind;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  /** Clave del periodo para no enviar dos veces el mismo (`2026-W47`, `2026-10`). */
  key: string;
  label: string;
}

/** Semana ISO (`2026-W47`) de un día. */
export function seoIsoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // jueves de esa semana
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7,
    );
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Periodo de un informe enviado `today` (hora de España):
 * - semanal: la semana de lunes a domingo anterior;
 * - mensual: el mes anterior.
 * El anterior, del mismo tamaño justo antes (la semana o el mes previos).
 */
export function seoReportPeriod(kind: SeoReportKind, today: string): SeoReportPeriod {
  if (kind === 'weekly') {
    const d = new Date(`${today}T00:00:00Z`);
    const monday = shiftDate(today, -((d.getUTCDay() + 6) % 7));
    const from = shiftDate(monday, -7);
    const to = shiftDate(monday, -1);
    return {
      kind,
      from,
      to,
      previousFrom: shiftDate(from, -7),
      previousTo: shiftDate(from, -1),
      key: seoIsoWeek(from),
      label: `semana del ${fmtDate(from)} al ${fmtDate(to)}`,
    };
  }
  const [y, m] = today.split('-').map(Number) as [number, number];
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  const from = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
  const to = shiftDate(`${y}-${String(m).padStart(2, '0')}-01`, -1);
  const beforeMonth = prevMonth === 1 ? 12 : prevMonth - 1;
  const beforeYear = prevMonth === 1 ? prevYear - 1 : prevYear;
  return {
    kind,
    from,
    to,
    previousFrom: `${beforeYear}-${String(beforeMonth).padStart(2, '0')}-01`,
    previousTo: shiftDate(from, -1),
    key: from.slice(0, 7),
    label: `${MONTHS[prevMonth - 1]} de ${prevYear}`,
  };
}

// --------------------------------------------------------------- ajustes

export interface SeoReportSettings {
  weekly: boolean;
  monthly: boolean;
  /**
   * Tenant: personas del equipo (con permiso de configurar) que lo reciben;
   * vacío = todas las que tienen ese permiso. Plataforma: super admins (vacío = todos).
   */
  recipientIds: string[];
  /** Solo en la plataforma: correos de fuera (p. ej. una agencia). */
  extraEmails: string[];
}

export const SEO_DEFAULT_REPORT_SETTINGS: SeoReportSettings = {
  weekly: false,
  monthly: true,
  recipientIds: [],
  extraEmails: [],
};

export const SEO_REPORT_RECIPIENTS_MAX = 20;
export const SEO_REPORT_EXTRA_EMAILS_MAX = 10;

export function seoReportSettingsOf(stored: unknown): SeoReportSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const strings = (v: unknown, max: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, max)
      : [];
  return {
    weekly: typeof s.weekly === 'boolean' ? s.weekly : SEO_DEFAULT_REPORT_SETTINGS.weekly,
    monthly: typeof s.monthly === 'boolean' ? s.monthly : SEO_DEFAULT_REPORT_SETTINGS.monthly,
    recipientIds: strings(s.recipientIds, SEO_REPORT_RECIPIENTS_MAX),
    extraEmails: strings(s.extraEmails, SEO_REPORT_EXTRA_EMAILS_MAX).map((e) => e.toLowerCase()),
  };
}

export const UpdateSeoReportSettingsSchema = z
  .object({
    weekly: z.boolean().optional(),
    monthly: z.boolean().optional(),
    recipientIds: z.array(z.string().uuid()).max(SEO_REPORT_RECIPIENTS_MAX).optional(),
    extraEmails: z
      .array(z.string().trim().toLowerCase().email().max(254))
      .max(SEO_REPORT_EXTRA_EMAILS_MAX)
      .optional(),
  })
  .strict();
export type UpdateSeoReportSettingsInput = z.infer<typeof UpdateSeoReportSettingsSchema>;

export const SendSeoReportSchema = z.object({
  kind: SeoReportKindEnum.default('weekly'),
});
export type SendSeoReportInput = z.infer<typeof SendSeoReportSchema>;

// --------------------------------------------------------------- contenido

export interface SeoReportKeywordMoveDto {
  keyword: string;
  position: number;
  previousPosition: number;
  /** Puestos que sube (positivo) o baja (negativo). */
  diff: number;
  clicks: number;
}

export interface SeoReportContentDto {
  period: SeoReportPeriod;
  project: { id: string; name: string; tenantId: string | null; domain: string | null };
  /** Los dos periodos tienen datos de Google de casi todos sus días. */
  complete: boolean;
  comparable: boolean;
  totals: SeoTotalsDto;
  previous: SeoTotalsDto | null;
  change: SeoChangeDto | null;
  conversions: {
    scope: 'tenant' | 'platform' | null;
    items: { type: SeoConversionType; count: number; previous: number | null }[];
    revenue: number | null;
    rate: number | null;
  };
  /** Visibilidad de SISTRIX (estimación) tuya y de tus competidores, si hay datos. */
  visibility: { domain: string; own: boolean; value: number; previous: number | null }[];
  keywordsUp: SeoReportKeywordMoveDto[];
  keywordsDown: SeoReportKeywordMoveDto[];
  opportunities: { query: string; type: string; score: number }[];
  cannibalizationsOpen: number;
  cannibalizations: { query: string; severity: string }[];
  indexFindingsOpen: number;
  changesWithResult: { title: string; date: string; verdict: string; text: string }[];
  tasksDone: number;
  tasksOverdue: number;
  alerts: { type: SeoAlertType; severity: SeoAlertSeverity; title: string; status: string }[];
  /** Inspección de URL y velocidad (PR 9) del periodo; null si no se hizo nada. */
  technical?: SeoReportTechnicalDto | null;
  highlights: string[];
}

/** Lo inspeccionado y medido en el periodo (PR 9). */
export interface SeoReportTechnicalDto {
  /** URL inspeccionadas en el periodo (su última inspección). */
  inspected: number;
  indexed: number;
  notIndexed: number;
  canonicalMismatch: number;
  /** URL medidas con PageSpeed en el periodo (móvil). */
  pagespeedUrls: number;
  /** De ellas, lentas para los usuarios reales o con puntuación por debajo de 50. */
  slowUrls: number;
  /** Media de la puntuación de rendimiento en el móvil. */
  avgMobileScore: number | null;
}

export interface SeoReportDto {
  id: string;
  kind: SeoReportKind;
  periodFrom: string;
  periodTo: string;
  periodKey: string;
  status: SeoReportStatus;
  /** Cron o a mano («Enviármelo ahora»). */
  trigger: 'cron' | 'manual';
  recipients: string[];
  hasPdf: boolean;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface SeoReportsDto {
  settings: SeoReportSettings;
  items: SeoReportDto[];
  /** Personas que pueden recibirlo (para elegir). */
  candidates: { id: string; name: string; email: string }[];
}

const pctText = (p: number | null) =>
  p === null ? null : `un ${String(Math.abs(Math.round(p * 10) / 10)).replace('.', ',')} %`;

/**
 * Lo más importante del periodo en frases sencillas (sin jerga y sin
 * atribuir causas: «coincide con», nunca «gracias a»).
 */
export function seoReportHighlights(c: Omit<SeoReportContentDto, 'highlights'>): string[] {
  const out: string[] = [];
  if (!c.complete) {
    out.push(
      'Google todavía no ha dado los datos de todos los días del periodo: las cifras pueden subir algo.',
    );
  }
  if (c.comparable && c.change) {
    const clicks = c.change.clicksPct;
    if (clicks !== null && Math.abs(clicks) >= 10) {
      out.push(
        clicks > 0
          ? `Has recibido ${pctText(clicks)} más de visitas desde Google que en el periodo anterior (${seoFmtInt(c.totals.clicks)} clics).`
          : `Has recibido ${pctText(clicks)} menos de visitas desde Google que en el periodo anterior (${seoFmtInt(c.totals.clicks)} clics).`,
      );
    } else {
      out.push(
        `Las visitas desde Google se mantienen: ${seoFmtInt(c.totals.clicks)} clics en el periodo.`,
      );
    }
  } else {
    out.push(`${seoFmtInt(c.totals.clicks)} clics desde Google en el periodo.`);
  }
  const conv = c.conversions.items.filter((i) => i.count > 0);
  if (conv.length > 0) {
    out.push(
      `Desde Google llegaron: ${conv
        .map((i) => `${seoFmtInt(i.count)} ${SEO_CONVERSION_TYPE_LABELS[i.type].toLowerCase()}`)
        .join(', ')}.`,
    );
  }
  const up = c.keywordsUp[0];
  if (up) out.push(`La que más sube: «${up.keyword}», ${seoFmtInt(up.diff)} puestos.`);
  const down = c.keywordsDown[0];
  if (down) out.push(`La que más baja: «${down.keyword}», ${seoFmtInt(-down.diff)} puestos.`);
  if (c.tasksOverdue > 0) {
    out.push(
      c.tasksOverdue === 1
        ? 'Hay 1 tarea SEO atrasada.'
        : `Hay ${seoFmtInt(c.tasksOverdue)} tareas SEO atrasadas.`,
    );
  }
  const tech = c.technical;
  if (tech && tech.inspected > 0) {
    out.push(
      tech.notIndexed > 0
        ? `Google ha confirmado ${seoFmtInt(tech.indexed)} de ${seoFmtInt(tech.inspected)} URL inspeccionadas; ${seoFmtInt(tech.notIndexed)} no están indexadas.`
        : `Google ha confirmado que tiene indexadas las ${seoFmtInt(tech.inspected)} URL inspeccionadas.`,
    );
  }
  if (tech && tech.slowUrls > 0) {
    out.push(
      tech.slowUrls === 1
        ? 'Hay 1 página lenta en el móvil: mira las mejoras sugeridas en «Velocidad».'
        : `Hay ${seoFmtInt(tech.slowUrls)} páginas lentas en el móvil: mira las mejoras sugeridas en «Velocidad».`,
    );
  }
  const open = c.alerts.filter((a) => a.status === 'open');
  if (open.length > 0) {
    out.push(
      `Alertas abiertas: ${open
        .slice(0, 3)
        .map((a) => SEO_ALERT_TYPE_LABELS[a.type].toLowerCase())
        .join(', ')}${open.length > 3 ? '…' : ''}.`,
    );
  }
  return out;
}
