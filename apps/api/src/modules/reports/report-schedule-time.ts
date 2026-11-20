import { todayInTimezone, zonedDayStart } from '../../common/format';

const DAY = 86_400_000;

const key = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Siguiente envío después de `after`, a la hora indicada en la zona del
 * negocio. Semanal: `weekday` 1 (lunes) a 7 (domingo). Mensual: `dayOfMonth`
 * 1 a 28.
 */
export function nextScheduleRun(
  s: { frequency: string; weekday: number | null; dayOfMonth: number | null; hour: number },
  timezone: string,
  after: Date = new Date(),
): Date {
  const today = todayInTimezone(timezone, after);
  const at = (day: Date) =>
    new Date(zonedDayStart(key(day), timezone).getTime() + s.hour * 3_600_000);
  for (let i = 0; i < 62; i++) {
    const day = new Date(today.getTime() + i * DAY);
    const matches =
      s.frequency === 'weekly'
        ? ((day.getUTCDay() + 6) % 7) + 1 === (s.weekday ?? 1)
        : day.getUTCDate() === (s.dayOfMonth ?? 1);
    if (matches && at(day) > after) return at(day);
  }
  return new Date(after.getTime() + 7 * DAY);
}

/**
 * Fechas del periodo que acaba de terminar, para los parámetros del informe:
 * la semana anterior (lunes a domingo) o el mes anterior.
 */
export function previousPeriod(
  frequency: string,
  timezone: string,
  runAt: Date,
): { from: string; to: string; month: string; atDate: string } {
  const today = todayInTimezone(timezone, runAt);
  let from: Date;
  let to: Date;
  if (frequency === 'weekly') {
    const weekday = (today.getUTCDay() + 6) % 7; // 0 = lunes
    to = new Date(today.getTime() - (weekday + 1) * DAY);
    from = new Date(to.getTime() - 6 * DAY);
  } else {
    from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  }
  return { from: key(from), to: key(to), month: key(to).slice(0, 7), atDate: key(today) };
}
