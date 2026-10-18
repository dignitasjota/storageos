/**
 * Fecha `YYYY-MM-DD` en la hora LOCAL del navegador. `toISOString()` da la
 * fecha en UTC: en España, entre las 00:00 y las 02:00, sería la de ayer.
 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Primer día del mes local (`monthsBack` meses atrás) en `YYYY-MM-DD`. */
export function localMonthStart(monthsBack = 0, now: Date = new Date()): string {
  return localDateString(new Date(now.getFullYear(), now.getMonth() - monthsBack, 1));
}
