import {
  WEEKDAYS,
  type DayHours,
  type OpeningException,
  type OpeningHours,
  type Weekday,
} from './schemas';

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function within(now: number, open: string, close: string): boolean {
  const from = minutes(open);
  let to = minutes(close);
  // «23:59» cuenta como hasta medianoche (un horario 24 h no debe salir cerrado ese minuto).
  if (to === 23 * 60 + 59) to = 24 * 60;
  // Cierre igual o anterior a la apertura: abre 24 h (00:00–00:00) o cruza la medianoche.
  if (to <= from) return to === from || now >= from || now < to;
  return now >= from && now < to;
}

/** Abierto las 24 horas ese día. */
export function isAllDay(h: DayHours | null | undefined): boolean {
  return !!h && h.open === '00:00' && (h.close === '00:00' || h.close === '23:59');
}

export function isOpenAt(h: DayHours | null | undefined, minuteOfDay: number): boolean {
  if (!h) return false;
  if (within(minuteOfDay, h.open, h.close)) return true;
  return !!h.open2 && !!h.close2 && within(minuteOfDay, h.open2, h.close2);
}

/** Lo que se enseña de un día: «09:00–14:00 y 16:00–20:00». */
export function dayHoursText(
  h: DayHours | null | undefined,
  labels: { closed: string; allDay: string; and: string },
): string {
  if (!h) return labels.closed;
  if (isAllDay(h)) return labels.allDay;
  const first = `${h.open}–${h.close}`;
  return h.open2 && h.close2 ? `${first} ${labels.and} ${h.open2}–${h.close2}` : first;
}

function localNow(timezone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: WEEKDAY_BY_SHORT[part('weekday') ?? ''],
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/**
 * ¿Abierto ahora, en la hora del local? Un festivo manda sobre el horario de la
 * semana. Null si no se puede saber.
 */
export function isOpenNow(
  hours: OpeningHours,
  timezone: string,
  exceptions: OpeningException[] = [],
  now = new Date(),
): boolean | null {
  try {
    const local = localNow(timezone, now);
    if (!local.weekday || Number.isNaN(local.minute)) return null;
    const exception = exceptions.find((e) => e.date === local.date);
    return isOpenAt(exception ? exception.hours : hours[local.weekday], local.minute);
  } catch {
    return null;
  }
}

/** Días especiales de las próximas semanas, de hoy en adelante y en orden. */
export function upcomingExceptions(
  exceptions: OpeningException[],
  timezone: string,
  days = 30,
  now = new Date(),
): OpeningException[] {
  let today: string;
  try {
    today = localNow(timezone, now).date;
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + days);
  const last = limit.toISOString().slice(0, 10);
  return exceptions
    .filter((e) => e.date >= today && e.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function hasOpeningHours(hours: OpeningHours | null | undefined): boolean {
  return WEEKDAYS.some((d) => !!hours?.[d]);
}
