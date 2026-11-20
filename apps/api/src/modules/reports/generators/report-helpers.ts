import { BadRequestException } from '@nestjs/common';

/** Rango máximo de un informe entre dos fechas (un PDF de más filas no se lee). */
export const REPORT_MAX_RANGE_DAYS = 366 * 2;

const DAY = 86_400_000;

/** «2026-10» → [1-oct, 1-nov) en UTC. */
export function monthRange(
  value: unknown,
  field: string,
): { start: Date; end: Date; label: string; key: string } {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value) : null;
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) {
    throw new BadRequestException({ code: 'invalid_date', message: `Elige un mes en «${field}»` });
  }
  const start = new Date(Date.UTC(Number(m[1]), month - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), month, 1));
  const label = start.toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return { start, end, label, key: `${m[1]}-${m[2]}` };
}

/** «2026-10-05» → ese día a las 00:00 UTC (columnas DATE). */
export function dayParam(value: unknown, field: string): Date {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCDate() !== Number(m[3])) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: `Elige una fecha válida en «${field}»`,
    });
  }
  return d;
}

/** Un periodo «desde – hasta» con sentido: en orden y de dos años como mucho. */
export function dayRange(params: Record<string, unknown>): {
  from: Date;
  to: Date;
  fromKey: string;
  toKey: string;
} {
  const from = dayParam(params.from, 'Desde');
  const to = dayParam(params.to, 'Hasta');
  if (from > to) {
    throw new BadRequestException({
      code: 'invalid_date_range',
      message: 'La fecha «Desde» no puede ser posterior a «Hasta»',
    });
  }
  if ((to.getTime() - from.getTime()) / DAY > REPORT_MAX_RANGE_DAYS) {
    throw new BadRequestException({
      code: 'date_range_too_long',
      message: 'El periodo no puede pasar de dos años',
    });
  }
  return { from, to, fromKey: String(params.from), toKey: String(params.to) };
}

/** Euros con punto de millar también en «5.094,82 €» (por defecto solo desde 10.000). */
export const EUR_FORMAT = {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
} as unknown as Intl.NumberFormatOptions;

export function eur(n: number): string {
  return n.toLocaleString('es-ES', EUR_FORMAT);
}

/** «05/10/2026» de una clave `AAAA-MM-DD` o de una fecha DATE (UTC). */
export function dayLabel(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const key = typeof value === 'string' ? value : value.toISOString().slice(0, 10);
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}/${m}/${y}` : '—';
}

/** Clave `AAAA-MM-DD` de un instante en la zona del negocio. */
export function zonedDayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Decimal con coma («16,6»). */
export function decimal(n: number, digits = 1): string {
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function customerDisplay(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return '—';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

export const CUSTOMER_NAME_SELECT = {
  customerType: true,
  firstName: true,
  lastName: true,
  companyName: true,
} as const;

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  sepa_debit: 'Domiciliación',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  bizum: 'Bizum',
  deposit: 'Fianza aplicada',
  other: 'Otros',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  issued: 'Emitida',
  paid: 'Pagada',
  overdue: 'Vencida',
  cancelled: 'Cancelada',
  refunded: 'Devuelta',
  partially_refunded: 'Devuelta en parte',
  rectified: 'Rectificada',
};

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  active: 'En vigor',
  ending: 'Baja pedida',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
};
