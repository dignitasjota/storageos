/**
 * Primer pago mensual de un contrato.
 *
 * Va del día de entrada a fin de mes, con el alquiler proporcional a esos
 * días. Si se entra a partir del día `nextMonthFromDay` (y no el día 1), el
 * primer pago incluye también el mes siguiente completo: así la siguiente
 * cuota no llega a los pocos días.
 */

/** Día por defecto a partir del cual el primer pago incluye el mes siguiente. */
export const DEFAULT_FIRST_PAYMENT_NEXT_MONTH_FROM_DAY = 20;

export interface FirstMonthPlan {
  /** Día de entrada (YYYY-MM-DD). */
  periodStart: string;
  /** Último día que cubre el primer pago (YYYY-MM-DD). */
  periodEnd: string;
  /** Días del mes de entrada que se pagan. */
  days: number;
  daysInMonth: number;
  /** El mes de entrada se paga entero (entrada el día 1). */
  fullFirstMonth: boolean;
  /** El primer pago incluye el mes siguiente completo. */
  includesNextMonth: boolean;
  /** Primer día del mes siguiente (YYYY-MM-DD), si se incluye. */
  nextMonthStart: string | null;
  /** Desde cuándo factura la recurrente (YYYY-MM-DD). */
  billingStartsOn: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m, d));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

/** Calcula lo que cubre el primer pago mensual para una fecha de entrada (YYYY-MM-DD). */
export function firstMonthPlan(
  startDate: string,
  nextMonthFromDay: number | null | undefined,
): FirstMonthPlan {
  const [y, m, d] = startDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  const month = m - 1;
  const daysInMonth = new Date(Date.UTC(y, month + 1, 0)).getUTCDate();
  const days = daysInMonth - d + 1;
  const fullFirstMonth = d === 1;
  const includesNextMonth = !fullFirstMonth && !!nextMonthFromDay && d >= nextMonthFromDay;
  return {
    periodStart: ymd(y, month, d),
    periodEnd: includesNextMonth ? ymd(y, month + 2, 0) : ymd(y, month + 1, 0),
    days,
    daysInMonth,
    fullFirstMonth,
    includesNextMonth,
    nextMonthStart: includesNextMonth ? ymd(y, month + 1, 1) : null,
    billingStartsOn: includesNextMonth ? ymd(y, month + 2, 1) : ymd(y, month + 1, 1),
  };
}

/** Importes en céntimos de un precio mensual para el primer pago. */
export function firstMonthCents(
  monthCents: number,
  plan: FirstMonthPlan,
): { firstMonth: number; nextMonth: number; total: number } {
  const firstMonth = plan.fullFirstMonth
    ? monthCents
    : Math.round((monthCents * plan.days) / plan.daysInMonth);
  const nextMonth = plan.includesNextMonth ? monthCents : 0;
  return { firstMonth, nextMonth, total: firstMonth + nextMonth };
}
