/**
 * Formatos del panel: un solo sitio para importes y fechas, para que se vean
 * igual en todas las pantallas («1.234,50 €», «01/09/2026»).
 */

/**
 * Agrupa los miles con punto también en las cifras de 4 dígitos («3.427»): el
 * formato español de `Intl` no los agrupa por debajo de 10.000.
 */
function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Importe en euros con coma decimal y separador de miles: «1.234,50 €». */
export function formatEur(n: number | string | null | undefined): string {
  const raw = typeof n === 'string' ? Number(n) : n;
  const v = raw == null || Number.isNaN(raw) ? 0 : raw;
  const [int, dec] = Math.abs(v).toFixed(2).split('.') as [string, string];
  const negative = v < 0 && (int !== '0' || dec !== '00');
  return `${negative ? '-' : ''}${groupThousands(int)},${dec} €`;
}

/** Porcentaje con coma decimal: «12,5 %». */
export function formatPct(n: number | null | undefined, decimals = 1): string {
  const v = n == null || Number.isNaN(n) ? 0 : n;
  return `${v.toFixed(decimals).replace('.', ',')} %`;
}

/** «1 mes», «3 meses»: el número con su palabra en singular o plural. */
export function plural(n: number, one: string, many: string): string {
  return `${groupThousands(String(n))} ${n === 1 ? one : many}`;
}

/** Precio con IVA (redondeado al céntimo) a partir del precio sin IVA y el tipo. */
export function withVat(net: number, taxRate: number): number {
  return Math.round(net * (1 + taxRate / 100) * 100) / 100;
}

/** «72,60 € con IVA» o, si no lleva IVA (vivienda), «Exento de IVA». */
export function vatIncludedLabel(net: number, taxRate: number): string {
  return taxRate > 0 ? `${formatEur(withVat(net, taxRate))} con IVA` : 'Exento de IVA';
}

/** Importe corto para los ejes de los gráficos: «1,2k €», «840 €». */
export function formatEurShort(n: number): string {
  return n >= 1000
    ? `${(Math.round(n / 100) / 10).toLocaleString('es-ES')}k €`
    : `${Math.round(n).toLocaleString('es-ES')} €`;
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
  const [int, dec] = Math.abs(n).toFixed(decimals).split('.') as [string, string | undefined];
  const negative = n < 0 && /[1-9]/.test(`${int}${dec ?? ''}`);
  return `${negative ? '-' : ''}${groupThousands(int)}${dec ? `,${dec}` : ''}`;
}

/** Recuento sin decimales: «1.250». */
export function formatCount(n: number | null | undefined): string {
  return formatNumber(n, 0);
}

/**
 * Importe escrito a mano en español: «1.500», «1.500,50», «12,5», «25 €» o
 * «10 %». null si no es un número.
 */
export function parseAmount(value: string): number | null {
  let v = value.replace(/[\s€%]/g, '');
  if (!v) return null;
  const comma = v.lastIndexOf(',');
  const dot = v.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // El último separador es el decimal; el otro, el de los miles.
    v = comma > dot ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  } else if (comma >= 0) {
    v = v.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  } else if (dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(v)) {
    v = v.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
