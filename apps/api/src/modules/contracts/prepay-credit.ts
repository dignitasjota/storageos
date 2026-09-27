/**
 * Baja anticipada de un contrato PREPAGADO (semestral/anual): cuántos meses
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
