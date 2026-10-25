import { BadRequestException } from '@nestjs/common';

/** «2026-10» → [1-oct, 1-nov) en UTC. */
export function monthRange(
  value: unknown,
  field: string,
): { start: Date; end: Date; label: string } {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value) : null;
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) {
    throw new BadRequestException({ code: 'invalid_date', message: `Mes no válido en «${field}»` });
  }
  const start = new Date(Date.UTC(Number(m[1]), month - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), month, 1));
  const label = start.toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return { start, end, label };
}

export function dayParam(value: unknown, field: string): Date {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCDate() !== Number(m[3])) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: `Fecha no válida en «${field}»`,
    });
  }
  return d;
}

export function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
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

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  sepa_debit: 'Domiciliación',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  other: 'Otros',
};
