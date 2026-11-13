/**
 * Fechas de un gasto recurrente: cada mes, cada trimestre o cada año, desde el
 * mes de inicio y hasta la fecha de fin, el día del mes elegido (1-28).
 * Fechas `YYYY-MM-DD`; «hoy» es el día del negocio.
 */

export type ExpenseFrequency = 'monthly' | 'quarterly' | 'yearly';

export const EXPENSE_FREQUENCY_MONTHS: Record<ExpenseFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

export interface RecurrenceRule {
  frequency: ExpenseFrequency;
  /** 1-28. */
  dayOfMonth: number;
  /** Mes de inicio (se usa su año y su mes). */
  startDate: string;
  /** Último día en que se genera; null = sin fin. */
  endDate: string | null;
}

const monthIndex = (d: string): number => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

function dateOf(index: number, day: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Primer día del mes de una fecha. */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Fechas en que toca el gasto hasta `until` (incluido), de la más antigua a la
 * más reciente. Como mucho las `limit` últimas.
 */
export function recurrenceDatesUntil(rule: RecurrenceRule, until: string, limit = 36): string[] {
  const step = EXPENSE_FREQUENCY_MONTHS[rule.frequency];
  const first = monthIndex(rule.startDate);
  const last = monthIndex(until);
  if (last < first) return [];
  const dates: string[] = [];
  for (let i = first + Math.floor((last - first) / step) * step; i >= first; i -= step) {
    const d = dateOf(i, rule.dayOfMonth);
    if (d > until) continue;
    if (rule.endDate && d > rule.endDate) continue;
    dates.unshift(d);
    if (dates.length >= limit) break;
  }
  return dates;
}

/** Próxima fecha a partir de `after` (sin incluirla); null si ya terminó. */
export function nextRecurrenceDate(rule: RecurrenceRule, after: string): string | null {
  const step = EXPENSE_FREQUENCY_MONTHS[rule.frequency];
  const first = monthIndex(rule.startDate);
  let i = Math.max(first, monthIndex(after));
  // Alinea con el inicio.
  const offset = (((i - first) % step) + step) % step;
  if (offset) i += step - offset;
  for (let n = 0; n < 3; n++, i += step) {
    const d = dateOf(i, rule.dayOfMonth);
    if (d <= after) continue;
    if (rule.endDate && d > rule.endDate) return null;
    return d;
  }
  return null;
}

/**
 * Qué toca generar a fecha `today`: la última fecha que ya llegó (`current`,
 * si no se generó aún) y las anteriores que se quedaron sin generar
 * (`missed`). `lastGenerated` es el primer día del mes del último gasto
 * generado.
 */
export function recurrencePending(
  rule: RecurrenceRule,
  today: string,
  lastGenerated: string | null,
): { current: string | null; missed: string[] } {
  const dates = recurrenceDatesUntil(rule, today, 24).filter(
    (d) => !lastGenerated || monthStartOf(d) > lastGenerated,
  );
  if (dates.length === 0) return { current: null, missed: [] };
  return { current: dates[dates.length - 1]!, missed: dates.slice(0, -1) };
}
