/**
 * Baja anticipada de un periodo PREPAGADO (semestral/anual, o el primer pago
 * de varios meses al contratar): cuántos meses
 * COMPLETOS del periodo pagado quedan sin consumir a fecha de baja.
 *
 * Un mes empezado cuenta como consumido (decisión: se abonan solo meses
 * completos). El mes k del periodo es `[periodStart + k meses, periodStart + k+1 meses)`.
 */
export function unusedPrepaidMonths(
  periodStart: Date,
  intervalMonths: number,
  endDate: Date,
): number {
  if (intervalMonths <= 1) return 0;
  const end = utcDay(endDate);
  let consumed = 0;
  // Meses iniciados hasta la fecha de baja (incluida).
  while (consumed < intervalMonths && addMonthsUtc(utcDay(periodStart), consumed) <= end) {
    consumed++;
  }
  return Math.max(0, intervalMonths - consumed);
}

/**
 * Importe a abonar de una línea prepagada: la parte proporcional a los meses
 * no consumidos, en céntimos exactos (redondeo al céntimo).
 */
export function creditForLine(lineAmount: number, intervalMonths: number, unused: number): number {
  if (unused <= 0 || intervalMonths <= 0) return 0;
  return Math.round((Math.round(lineAmount * 100) * unused) / intervalMonths) / 100;
}

/**
 * Meses que cubre un periodo pagado por adelantado: `[inicio, inicio + N
 * meses − 1 día]` con N ≥ 2. 0 si no es un número entero de meses (una
 * factura mensual, o la de un alta prorrateada).
 */
export function prepaidPeriodMonths(periodStart: Date, periodEnd: Date): number {
  const start = utcDay(periodStart);
  const end = utcDay(periodEnd).getTime();
  for (let n = 2; n <= 24; n++) {
    const last = addMonthsUtc(start, n);
    last.setUTCDate(last.getUTCDate() - 1);
    if (last.getTime() === end) return n;
    if (last.getTime() > end) return 0;
  }
  return 0;
}

/**
 * Abono del alquiler de un periodo prepagado cuando el inquilino se va antes:
 * lo pagado menos los meses usados a la cuota mensual del contrato (quien no
 * completa el periodo pierde el descuento o los meses gratis de ese pago).
 * Nunca más que la parte proporcional de lo pagado ni menos de 0.
 */
export function rentCreditWithoutDiscount(args: {
  /** Base pagada por el alquiler del periodo. */
  paid: number;
  months: number;
  unused: number;
  /** Cuota mensual del contrato, sin IVA (con su descuento fijo, si lo tiene). */
  monthlyPrice: number;
}): number {
  if (args.unused <= 0 || args.months <= 0) return 0;
  const paidCents = Math.round(args.paid * 100);
  const used = args.months - args.unused;
  const withoutDiscount = paidCents - used * Math.round(args.monthlyPrice * 100);
  const proportional = Math.round((paidCents * args.unused) / args.months);
  return Math.max(0, Math.min(withoutDiscount, proportional)) / 100;
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addMonthsUtc(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
