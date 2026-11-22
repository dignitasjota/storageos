/**
 * Cálculos de los leads del panel admin que no dependen de la base de datos:
 * puntuación (con sus motivos), cuota prevista, leads parados y plazo de
 * primera respuesta. Los usan el API (tablero, lista, avisos) y la web.
 */

import type { PlatformLeadStage } from './leads';

const DAY = 86_400_000;

// ------------------------------------------------------------------ números

/**
 * El número que alguien escribió en «trasteros» o «locales»: «150», «unos
 * 200», «1.200», «entre 50 y 80» (se toma el mayor). null si no hay número.
 */
export function parseLeadCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text.replace(/(\d)[.\s](\d{3})\b/g, '$1$2');
  const numbers = (normalized.match(/\d+/g) ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numbers.length === 0) return null;
  return Math.min(Math.max(...numbers), 1_000_000);
}

// --------------------------------------------------------------- puntuación

export interface PlatformLeadScoreFactor {
  key: string;
  label: string;
  points: number;
}

export interface PlatformLeadScore {
  score: number;
  factors: PlatformLeadScoreFactor[];
}

export interface PlatformLeadScoreInput {
  status: PlatformLeadStage;
  source: string;
  units: string | null;
  facilities: string | null;
  /** Ha contestado (correo, llamada, demo o reunión). */
  replied: boolean;
  /** Veces que ha abierto el enlace de alguna propuesta. */
  proposalOpens: number;
  lastActivityAt: string | Date | null;
  /** Último correo o propuesta que le mandamos. */
  lastOutboundAt: string | Date | null;
  /** Último mensaje suyo (formulario o correo). */
  lastInboundAt: string | Date | null;
  createdAt: string | Date;
}

/** Puntos por origen: quien pide una demo vale más que un contacto frío. */
export const PLATFORM_LEAD_SOURCE_POINTS: Record<string, number> = {
  demo: 15,
  referral: 12,
  signup: 12,
  calculator: 10,
  web_contact: 10,
  partner: 10,
  event: 8,
  phone: 8,
  email: 6,
  ads: 6,
  social: 5,
  admin: 4,
  other: 3,
};

const time = (v: string | Date | null | undefined): number | null =>
  v ? new Date(v).getTime() : null;

/**
 * Puntuación de 0 a 100 de lo probable que es que acabe pagando, con cada
 * motivo y sus puntos (para enseñarlos en la ficha). Cliente es 100 y perdido 0.
 */
export function scorePlatformLead(
  input: PlatformLeadScoreInput,
  now = new Date(),
): PlatformLeadScore {
  if (input.status === 'customer') {
    return { score: 100, factors: [{ key: 'customer', label: 'Ya es cliente', points: 100 }] };
  }
  if (input.status === 'lost') {
    return { score: 0, factors: [{ key: 'lost', label: 'Perdido', points: 0 }] };
  }
  const factors: PlatformLeadScoreFactor[] = [];
  const add = (key: string, label: string, points: number) => {
    if (points !== 0) factors.push({ key, label, points });
  };

  const units = parseLeadCount(input.units);
  if (units !== null) {
    const points = units >= 300 ? 25 : units >= 100 ? 20 : units >= 50 ? 15 : units >= 20 ? 9 : 4;
    add('units', `${units} ${units === 1 ? 'trastero' : 'trasteros'}`, points);
  }
  const facilities = parseLeadCount(input.facilities);
  if (facilities !== null && facilities >= 2) {
    add('facilities', `${facilities} locales`, facilities >= 3 ? 8 : 5);
  }
  add('source', 'Origen', PLATFORM_LEAD_SOURCE_POINTS[input.source] ?? 3);
  if (input.replied) add('replied', 'Ha respondido', 15);
  if (input.proposalOpens >= 3) {
    add('proposal', `Abrió la propuesta ${input.proposalOpens} veces`, 15);
  } else if (input.proposalOpens > 0) {
    add('proposal', 'Abrió la propuesta', 10);
  }
  if (input.status === 'interested') add('stage', 'Interesado', 8);
  if (input.status === 'trial') add('stage', 'Probando su cuenta', 12);

  const last = time(input.lastActivityAt) ?? time(input.createdAt) ?? now.getTime();
  const idle = Math.floor((now.getTime() - last) / DAY);
  if (idle <= 3) add('recent', 'Actividad reciente', 10);
  else if (idle <= 7) add('recent', 'Actividad esta semana', 5);
  else if (idle > 30) add('recent', `Sin actividad desde hace ${idle} días`, -10);

  const outbound = time(input.lastOutboundAt);
  const inbound = time(input.lastInboundAt);
  if (outbound !== null && (inbound === null || inbound < outbound)) {
    const waiting = Math.floor((now.getTime() - outbound) / DAY);
    if (waiting >= 14) add('silence', `Sin respuesta desde hace ${waiting} días`, -15);
    else if (waiting >= 7) add('silence', `Sin respuesta desde hace ${waiting} días`, -8);
  }

  const total = factors.reduce((s, f) => s + f.points, 0);
  return { score: Math.max(0, Math.min(100, Math.round(total))), factors };
}

// ------------------------------------------------------------ cuota prevista

export interface PlatformLeadValuePlan {
  slug: string;
  name: string;
  priceMonthly: number;
  maxUnits: number | null;
  /** Trasteros incluidos (plan por trastero); null = cuota fija. */
  includedUnits: number | null;
  isActive: boolean;
  isPublic: boolean;
}

export interface PlatformLeadValueContext {
  plans: PlatformLeadValuePlan[];
  /** Precio de cada trastero de más (extra interno), si lo hay. */
  extraUnitPrice: number | null;
  pricesIncludeVat: boolean;
  taxRate: number;
}

export interface PlatformLeadValue {
  /** Cuota prevista al mes, sin IVA. */
  monthly: number;
  planSlug: string;
  planName: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function planCost(plan: PlatformLeadValuePlan, units: number | null, extra: number | null): number {
  const over =
    plan.includedUnits !== null && units !== null ? Math.max(0, units - plan.includedUnits) : 0;
  return plan.priceMonthly + over * (extra ?? 0);
}

/**
 * Cuota prevista (sin IVA) de un lead: la del plan que le interesa o, si no
 * lo ha dicho, la del plan más barato en el que caben sus trasteros (los de
 * más, al precio del extra). Sin trasteros ni plan, null: no se sabe.
 */
export function estimatePlatformLeadValue(
  lead: { units: string | null; planSlug: string | null },
  ctx: PlatformLeadValueContext,
): PlatformLeadValue | null {
  const units = parseLeadCount(lead.units);
  const active = ctx.plans.filter((p) => p.isActive);
  let plan = lead.planSlug ? (active.find((p) => p.slug === lead.planSlug) ?? null) : null;
  if (!plan) {
    if (units === null) return null;
    const fits = active
      .filter((p) => p.isPublic && p.priceMonthly > 0)
      .filter((p) => p.maxUnits === null || p.maxUnits >= units)
      .sort(
        (a, b) =>
          planCost(a, units, ctx.extraUnitPrice) - planCost(b, units, ctx.extraUnitPrice) ||
          a.priceMonthly - b.priceMonthly,
      );
    plan = fits[0] ?? null;
  }
  if (!plan) return null;
  const gross = planCost(plan, units, ctx.extraUnitPrice);
  const net = ctx.pricesIncludeVat ? gross / (1 + ctx.taxRate / 100) : gross;
  return { monthly: round2(net), planSlug: plan.slug, planName: plan.name };
}

// ---------------------------------------------------------------- parados

export type PlatformLeadStaleDays = Record<'new' | 'contacted' | 'interested' | 'trial', number>;

/** Días sin actividad para dar un lead por parado, por fase. */
export const PLATFORM_LEAD_STALE_DEFAULTS: PlatformLeadStaleDays = {
  new: 1,
  contacted: 5,
  interested: 7,
  trial: 10,
};

/** Cuota prevista (sin IVA) a partir de la que un lead es de alto valor. */
export const PLATFORM_LEAD_HIGH_VALUE_MONTHLY = 150;

/**
 * Días que lleva sin actividad si ya pasó el umbral de su fase; null si no
 * está parado (o ya no está abierto).
 */
export function staleDaysOf(
  lead: { status: string; lastActivityAt: string | Date | null; createdAt: string | Date },
  thresholds: PlatformLeadStaleDays = PLATFORM_LEAD_STALE_DEFAULTS,
  now = new Date(),
): number | null {
  if (!(lead.status in thresholds)) return null;
  const limit = thresholds[lead.status as keyof PlatformLeadStaleDays];
  const last = time(lead.lastActivityAt) ?? time(lead.createdAt);
  if (last === null || !limit) return null;
  const days = Math.floor((now.getTime() - last) / DAY);
  return days >= limit ? days : null;
}

// ------------------------------------------------------- plazo de respuesta

/** Hora en España (día de la semana 0 = domingo, minutos desde medianoche). */
function madridParts(d: Date): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: days[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Horario laborable: de lunes a viernes, de 9:00 a 18:00 (hora de España). */
export const PLATFORM_LEAD_BUSINESS_HOURS = { start: 9 * 60, end: 18 * 60 };

export function isBusinessTime(d: Date): boolean {
  const { weekday, minutes } = madridParts(d);
  return (
    weekday >= 1 &&
    weekday <= 5 &&
    minutes >= PLATFORM_LEAD_BUSINESS_HOURS.start &&
    minutes < PLATFORM_LEAD_BUSINESS_HOURS.end
  );
}

/**
 * Hasta cuándo hay para responder: `hours` horas desde `start`, o `hours`
 * horas laborables si `businessOnly` (se cuentan a tramos de 15 minutos).
 */
export function responseDeadline(start: Date, hours: number, businessOnly: boolean): Date {
  if (!businessOnly) return new Date(start.getTime() + hours * 3_600_000);
  const step = 15 * 60_000;
  let remaining = Math.max(0, Math.round(hours * 4));
  let t = start.getTime();
  // Como mucho un mes de calendario (un plazo absurdo no cuelga el proceso).
  for (let i = 0; remaining > 0 && i < 4 * 24 * 31; i += 1) {
    if (isBusinessTime(new Date(t + step / 2))) remaining -= 1;
    t += step;
  }
  return new Date(t);
}

// ------------------------------------------------------------- duplicados

const LEGAL_FORMS =
  /\b(s\.?\s?l\.?\s?u?|s\.?\s?a\.?|s\.?\s?c\.?|s\.?\s?l\.?\s?l\.?|sociedad|limitada|anonima|cb|scp)\b/g;

/** Nombre de empresa para comparar: sin tildes, signos ni forma jurídica. */
export function normalizeCompanyName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Dos nombres de empresa que parecen la misma (igual o uno contiene al otro). */
export function similarCompanyNames(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

/** Un NIF o CIF dentro de un texto (en mayúsculas), o null. */
export function findTaxId(text: string | null | undefined): string | null {
  const m = /\b([A-HJ-NP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/i.exec(text ?? '');
  return m ? m[1]!.toUpperCase() : null;
}
