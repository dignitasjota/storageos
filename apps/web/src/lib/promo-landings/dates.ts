/**
 * Fechas de las landings en la zona horaria del negocio (no en la del
 * navegador): «hasta el 31» termina a las 23:59:59 del 31 en el local, aunque
 * quien la edite esté en otro huso.
 */

/** Diferencia (ms) entre la hora de la zona y UTC en ese instante. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** `YYYY-MM-DD` (día en la zona) de un instante ISO, o '' si no hay. */
export function isoToZonedDate(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('sv-SE', { timeZone });
}

/** Inicio del día (o su último segundo) en la zona, como instante ISO. */
export function zonedDateToIso(value: string, timeZone: string, endOfDay: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const wall = Date.parse(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  if (Number.isNaN(wall)) return null;
  // Dos pasadas: el desfase puede cambiar ese día (horario de verano).
  let t = wall - offsetMs(new Date(wall), timeZone);
  t = wall - offsetMs(new Date(t), timeZone);
  return new Date(t).toISOString();
}

/** Día y hora (`YYYY-MM-DD`, `HH:MM`) en la zona de un instante ISO. */
export function isoToZonedDateTime(
  iso: string | null,
  timeZone: string,
): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const time = d.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return { date: d.toLocaleDateString('sv-SE', { timeZone }), time };
}

/** Instante ISO del día y la hora (`HH:MM`) en la zona del negocio. */
export function zonedDateTimeToIso(date: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(wall)) return null;
  // Dos pasadas: el desfase puede cambiar ese día (horario de verano).
  let t = wall - offsetMs(new Date(wall), timeZone);
  t = wall - offsetMs(new Date(t), timeZone);
  return new Date(t).toISOString();
}

/** «25 de noviembre de 2026, 9:00» en la zona del negocio. */
export function formatZonedDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-ES', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
