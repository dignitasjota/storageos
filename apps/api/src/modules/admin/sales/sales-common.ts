import {
  type SalesAccountProfileDto,
  type SalesCallOutcome,
  type SalesTemperature,
  salesMonth,
} from '@storageos/shared';

import { zonedDayStart } from '../../../common/format';

/** Quien actúa: un comercial (o un super admin desde sus pantallas). */
export interface SalesActor {
  repId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const DAY = 86_400_000;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hoy (AAAA-MM-DD) en hora de España. */
export function madridToday(now = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
}

/** Mes (AAAA-MM) de una fecha en hora de España. */
export function monthOf(d: Date): string {
  return salesMonth(d);
}

/** Suma días a una fecha AAAA-MM-DD. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Inicio y fin (excluido) del mes AAAA-MM en hora de España. */
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: zonedDayStart(`${month}-01`), to: zonedDayStart(`${next}-01`) };
}

export const clean = (v: string | null | undefined): string | null =>
  v && v.trim() ? v.trim() : null;

export const digits = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '');

/** Las 9 últimas cifras de un teléfono (para comparar sin prefijo). */
export const phoneTail = (v: string | null | undefined): string | null => {
  const t = digits(v).slice(-9);
  return t.length === 9 ? t : null;
};

export interface ProfileRow {
  pinnedNote: string | null;
  status: string | null;
  temperature: string | null;
  decisionMaker: string | null;
  bestTime: string | null;
  nextAction: string | null;
  lastOutcome: string | null;
  lastContactAt: Date | null;
  trialExtensionDays: number;
  addonTrials: number;
  updatedAt: Date;
}

export function profileDto(row: ProfileRow | null | undefined): SalesAccountProfileDto | null {
  if (!row) return null;
  return {
    pinnedNote: row.pinnedNote,
    status: row.status,
    temperature: (row.temperature as SalesTemperature | null) ?? null,
    decisionMaker: row.decisionMaker,
    bestTime: row.bestTime,
    nextAction: row.nextAction,
    lastOutcome: (row.lastOutcome as SalesCallOutcome | null) ?? null,
    lastContactAt: row.lastContactAt?.toISOString() ?? null,
    trialExtensionDays: row.trialExtensionDays,
    addonTrials: row.addonTrials,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Días que faltan (redondeo hacia arriba; negativo si ya pasó). */
export function daysUntil(date: Date | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  return Math.ceil((date.getTime() - now.getTime()) / DAY);
}

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
