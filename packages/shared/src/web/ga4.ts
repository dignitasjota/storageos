import { z } from 'zod';

import { shiftDate } from './search-console';

/**
 * Google Analytics 4 de la web del tenant (dentro de Web Premium). La cuenta
 * de servicio de la plataforma lee la propiedad del tenant y cada día se
 * guardan sus sesiones por origen y sus páginas vistas.
 */

/** Acepta `123456789` o `properties/123456789` y se queda con el número. */
export const ConnectGa4Schema = z.object({
  propertyId: z
    .string()
    .trim()
    .transform((v) => v.replace(/^properties\//i, ''))
    .pipe(
      z
        .string()
        .regex(
          /^\d{5,15}$/,
          'Escribe el ID de la propiedad: un número que sale en Administrar → Configuración de la propiedad',
        ),
    ),
});
export type ConnectGa4Input = z.infer<typeof ConnectGa4Schema>;

export type Ga4Status = 'pending' | 'connected' | 'error';

export interface Ga4SettingsDto {
  /** La plataforma tiene cuenta de servicio configurada. */
  available: boolean;
  /** Email que el tenant añade como «Lector» en su propiedad. */
  serviceAccountEmail: string | null;
  propertyId: string | null;
  status: Ga4Status | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
}

/** Fila diaria por origen tal como se guarda (y como la da la API de GA4). */
export interface Ga4SourceRowInput {
  date: string;
  source: string;
  medium: string;
  campaign: string;
  device: string;
  sessions: number;
  engagedSessions: number;
  pageViews: number;
  keyEvents: number;
}

export interface Ga4PageRowInput {
  date: string;
  pagePath: string;
  pageViews: number;
  sessions: number;
}

export interface Ga4TotalsDto {
  sessions: number;
  engagedSessions: number;
  /** Sesiones con interacción / sesiones (0-1); null sin sesiones. */
  engagementRate: number | null;
  pageViews: number;
  /** Eventos clave (conversiones) que el tenant marcó en GA4. */
  keyEvents: number;
}

export interface Ga4SourceDto extends Ga4TotalsDto {
  source: string;
  medium: string;
}

export interface Ga4ReportDto {
  days: number;
  from: string;
  to: string;
  totals: Ga4TotalsDto;
  previous: Ga4TotalsDto;
  daily: { date: string; sessions: number }[];
  sources: Ga4SourceDto[];
  pages: { path: string; pageViews: number; sessions: number }[];
  devices: { device: string; sessions: number }[];
}

const emptyTotals = (): Ga4TotalsDto => ({
  sessions: 0,
  engagedSessions: 0,
  engagementRate: null,
  pageViews: 0,
  keyEvents: 0,
});

function addRow(t: Ga4TotalsDto, r: Ga4SourceRowInput): void {
  t.sessions += r.sessions;
  t.engagedSessions += r.engagedSessions;
  t.pageViews += r.pageViews;
  t.keyEvents += r.keyEvents;
}

function withRate<T extends Ga4TotalsDto>(t: T): T {
  return {
    ...t,
    engagementRate:
      t.sessions > 0 ? Math.round((t.engagedSessions / t.sessions) * 1000) / 1000 : null,
  };
}

/**
 * Resumen de los últimos `days` días que terminan en `to` (incluido) frente
 * al periodo anterior de la misma duración.
 */
export function summarizeGa4(
  sources: Ga4SourceRowInput[],
  pages: Ga4PageRowInput[],
  days: number,
  to: string,
): Ga4ReportDto {
  const from = shiftDate(to, -(days - 1));
  const prevFrom = shiftDate(from, -days);
  const totals = emptyTotals();
  const previous = emptyTotals();
  const daily = new Map<string, number>();
  for (let d = from; d <= to; d = shiftDate(d, 1)) daily.set(d, 0);
  const bySource = new Map<string, Ga4SourceDto>();
  const byDevice = new Map<string, number>();

  for (const r of sources) {
    if (r.date >= prevFrom && r.date < from) {
      addRow(previous, r);
      continue;
    }
    if (r.date < from || r.date > to) continue;
    addRow(totals, r);
    daily.set(r.date, (daily.get(r.date) ?? 0) + r.sessions);
    const key = `${r.source}\u0000${r.medium}`;
    let s = bySource.get(key);
    if (!s) {
      s = { source: r.source, medium: r.medium, ...emptyTotals() };
      bySource.set(key, s);
    }
    addRow(s, r);
    byDevice.set(r.device, (byDevice.get(r.device) ?? 0) + r.sessions);
  }

  const byPage = new Map<string, { path: string; pageViews: number; sessions: number }>();
  for (const p of pages) {
    if (p.date < from || p.date > to) continue;
    let row = byPage.get(p.pagePath);
    if (!row) {
      row = { path: p.pagePath, pageViews: 0, sessions: 0 };
      byPage.set(p.pagePath, row);
    }
    row.pageViews += p.pageViews;
    row.sessions += p.sessions;
  }

  return {
    days,
    from,
    to,
    totals: withRate(totals),
    previous: withRate(previous),
    daily: [...daily.entries()].map(([date, sessions]) => ({ date, sessions })),
    sources: [...bySource.values()]
      .map(withRate)
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 20),
    pages: [...byPage.values()].sort((a, b) => b.pageViews - a.pageViews).slice(0, 15),
    devices: [...byDevice.entries()]
      .map(([device, sessions]) => ({ device, sessions }))
      .filter((d) => d.sessions > 0)
      .sort((a, b) => b.sessions - a.sessions),
  };
}
