/**
 * Reglas del fichero de adeudos (cuaderno AEB 19-14, esquema CORE) que hay que
 * respetar antes de generarlo: la fecha de cobro tiene que ser un día hábil
 * TARGET2, no puede haber pasado y no puede estar a más de un año, y los textos
 * solo admiten el juego de caracteres SEPA con longitudes máximas.
 */

const DAY_MS = 86_400_000;

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Domingo de Pascua (algoritmo anónimo gregoriano), en UTC. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Festivos TARGET2: 1 ene, Viernes Santo, Lunes de Pascua, 1 may, 25 y 26 dic. */
export function isTargetHoliday(date: string): boolean {
  const d = utcDate(date);
  const md = date.slice(5);
  if (md === '01-01' || md === '05-01' || md === '12-25' || md === '12-26') return true;
  const easter = easterSunday(d.getUTCFullYear()).getTime();
  const t = d.getTime();
  return t === easter - 2 * DAY_MS || t === easter + DAY_MS;
}

/** Día hábil para los adeudos SEPA: de lunes a viernes y no festivo TARGET2. */
export function isSepaBusinessDay(date: string): boolean {
  const wd = utcDate(date).getUTCDay();
  return wd !== 0 && wd !== 6 && !isTargetHoliday(date);
}

/** El primer día hábil SEPA igual o posterior a `date`. */
export function nextSepaBusinessDay(date: string): string {
  let d = utcDate(date);
  while (!isSepaBusinessDay(iso(d))) d = new Date(d.getTime() + DAY_MS);
  return iso(d);
}

/** Máximo de días de antelación de la fecha de cobro. */
export const SEPA_MAX_COLLECTION_DAYS = 365;

export type CollectionDateIssue = 'past' | 'too_far' | 'not_business_day';

/**
 * Comprueba la fecha de cobro respecto a hoy (`today` en `YYYY-MM-DD`, en hora
 * de España). Devuelve el problema y la fecha válida más cercana, o null.
 */
export function collectionDateIssue(
  date: string,
  today: string,
): { issue: CollectionDateIssue; suggestion: string } | null {
  if (date <= today) {
    return {
      issue: 'past',
      suggestion: nextSepaBusinessDay(iso(new Date(utcDate(today).getTime() + DAY_MS))),
    };
  }
  const max = iso(new Date(utcDate(today).getTime() + SEPA_MAX_COLLECTION_DAYS * DAY_MS));
  if (date > max) return { issue: 'too_far', suggestion: max };
  if (!isSepaBusinessDay(date))
    return { issue: 'not_business_day', suggestion: nextSepaBusinessDay(date) };
  return null;
}

export const COLLECTION_DATE_MESSAGES: Record<CollectionDateIssue, string> = {
  past: 'La fecha de cobro tiene que ser posterior a hoy.',
  too_far: 'La fecha de cobro no puede estar a más de un año.',
  not_business_day:
    'La fecha de cobro tiene que ser un día hábil (de lunes a viernes y no festivo del calendario TARGET2).',
};

const SEPA_CHAR_MAP: Record<string, string> = {
  ñ: 'n',
  Ñ: 'N',
  ç: 'c',
  Ç: 'C',
  '&': '+',
  '€': 'EUR',
  ª: 'a',
  º: 'o',
  '"': "'",
};

/**
 * Adapta un texto al juego de caracteres SEPA (letras sin acentos, cifras y
 * `/ - ? : ( ) . , ' +` y espacio) y lo recorta a `max` caracteres.
 */
export function sepaText(value: string, max: number): string {
  const mapped = [...value].map((ch) => SEPA_CHAR_MAP[ch] ?? ch).join('');
  const plain = mapped.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const clean = plain
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, max).trim();
}

/**
 * Identificador SEPA (MsgId, PmtInfId, EndToEndId, referencia del mandato):
 * caracteres SEPA sin espacios, máximo 35, sin empezar ni acabar en `/` ni
 * contener `//`.
 */
export function sepaId(value: string, max = 35): string {
  const s = sepaText(value, 200)
    .replace(/ /g, '')
    .replace(/\/{2,}/g, '/')
    .slice(0, max);
  return s.replace(/^\/+|\/+$/g, '');
}
