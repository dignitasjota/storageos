/**
 * Formatos del panel: un solo sitio para importes y fechas, para que se vean
 * igual en todas las pantallas («1.234,50 €», «01/09/2026»).
 */

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

/** Importe en euros con coma decimal y separador de miles: «1.234,50 €». */
export function formatEur(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return EUR.format(v == null || Number.isNaN(v) ? 0 : v);
}

/**
 * Una fecha `YYYY-MM-DD` se lee como día local (con `new Date('2026-09-01')`
 * sería medianoche UTC y en algunas zonas saldría el día anterior). Las
 * exportaciones para la asesoría ya vienen como `DD/MM/AAAA`.
 */
function toDate(d: string | Date): Date {
  if (d instanceof Date) return d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(`${d}T00:00:00`);
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00`);
  return new Date(d);
}

/** Fecha corta: «01/09/2026». Vacía o inválida → «—». */
export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = toDate(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Fecha y hora: «01/09/2026, 10:30». */
export function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = toDate(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Número con coma decimal: «4,50». */
export function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
