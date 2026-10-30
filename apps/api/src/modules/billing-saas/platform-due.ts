const DAY_MS = 24 * 60 * 60 * 1000;
/** Tope de cuotas que se cuentan como deuda (tres años). */
const MAX_PERIODS = 36;

/**
 * Suma meses a una fecha en UTC sin desbordar el fin de mes (31 ene + 1 mes →
 * 28/29 feb, no 3 mar). Para series, calcular siempre desde la fecha inicial
 * (`addMonthsUtc(first, i * step)`) y no encadenar: 31 → 28 → 28.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const target = new Date(
    Date.UTC(
      y,
      m,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/**
 * Desde cuándo debe el tenant. En pago manual, SEPA y tarjeta de Redsys, el
 * fin del periodo pagado. En Stripe, el periodo ya avanzó al del cobro que
 * falló: se debe desde su inicio (más el crédito de pagos manuales). Lo usan
 * el escalado de impagos y los cobros pendientes del panel admin, para que
 * los dos cuenten los mismos días.
 */
export function subscriptionDueDate(sub: {
  billingMode: string;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  manualExtensionDays: number;
}): Date {
  if (sub.billingMode === 'stripe' && sub.stripeSubscriptionId) {
    return new Date(sub.currentPeriodStart.getTime() + sub.manualExtensionDays * DAY_MS);
  }
  return sub.currentPeriodEnd;
}

/**
 * Cuotas vencidas sin pagar desde `since`: una por cada inicio de periodo que
 * ya ha llegado. Con Stripe es siempre una (la factura que reintenta Stripe).
 */
export function periodsOwed(
  since: Date,
  now: Date,
  stepMonths: number,
  chargedByStripe: boolean,
): number {
  if (chargedByStripe || now < since) return 1;
  let n = 1;
  while (n < MAX_PERIODS && addMonthsUtc(since, n * stepMonths) <= now) n++;
  return n;
}
