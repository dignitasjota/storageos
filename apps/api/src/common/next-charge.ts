const DAY = 86_400_000;
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * Próximo cargo de un contrato: el primer día que no está ya pagado. Mensual →
 * el día 1 del mes siguiente, salvo que ya pagara meses por adelantado o que la
 * facturación empiece más tarde (entonces cobra la parte de ese mes); prepagado
 * → el día siguiente al fin del último periodo. Con meses gratis el alquiler
 * sale a 0 y la protección se sigue cobrando.
 */
export function nextContractCharge(
  c: {
    billingIntervalMonths: number;
    billingStartsOn: Date | null;
    freeMonthsRemaining: number;
    prepayDiscountPct: unknown;
    /** Fin del último periodo facturado. */
    coveredUntil: Date | null;
  },
  amounts: { rent: number; insurance: number },
  today: Date,
): { date: Date; amount: number } {
  const firstOfNextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const nextUncovered = c.coveredUntil ? new Date(c.coveredUntil.getTime() + DAY) : null;
  const rent = c.freeMonthsRemaining > 0 ? 0 : amounts.rent;
  if (c.billingIntervalMonths > 1) {
    const pct = Number(c.prepayDiscountPct) / 100;
    return {
      date: nextUncovered ?? c.billingStartsOn ?? firstOfNextMonth,
      amount: (rent * (1 - pct) + amounts.insurance) * c.billingIntervalMonths,
    };
  }
  let date = firstOfNextMonth;
  for (const d of [nextUncovered, c.billingStartsOn]) {
    if (d && startOfMonth(d) > date) date = startOfMonth(d);
  }
  // Si la facturación empieza a mitad de ese mes, se cobra la parte.
  let share = 1;
  const from = [nextUncovered, c.billingStartsOn]
    .filter((d): d is Date => !!d && startOfMonth(d).getTime() === date.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (from && from.getUTCDate() > 1) {
    const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    share = (days - from.getUTCDate() + 1) / days;
  }
  return { date, amount: (rent + amounts.insurance) * share };
}
