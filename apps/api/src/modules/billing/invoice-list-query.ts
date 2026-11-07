import { BadRequestException } from '@nestjs/common';
import {
  InvoicePaymentFilterEnum,
  InvoiceSortEnum,
  InvoiceStatusEnum,
  InvoiceTypeFilterEnum,
} from '@storageos/shared';

import { assertUuid } from '../../common/pagination';

import type { ListFilters } from './invoices.service';

/** Parámetros de la lista de facturas tal como llegan en la URL. */
export type InvoiceListQuery = Partial<Record<string, string>>;

/** Día real (AAAA-MM-DD): una fecha imposible es un 400, no un 500. */
function day(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime())) {
    throw new BadRequestException({ code: 'invalid_date', message: `Fecha no válida (${field})` });
  }
  if (d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException({ code: 'invalid_date', message: `Fecha no válida (${field})` });
  }
  return value;
}

function oneOf<T extends string>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  value: string | undefined,
  code: string,
  message: string,
): T | undefined {
  if (!value) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code, message });
  return parsed.data;
}

/** Filtros de la lista (y de sus totales) a partir de la URL. */
export function parseInvoiceListQuery(
  q: InvoiceListQuery,
): Omit<ListFilters, 'facilityScope' | 'page'> {
  assertUuid(q.customerId);
  assertUuid(q.contractId);
  assertUuid(q.facilityId);
  const status = oneOf(InvoiceStatusEnum, q.status, 'invalid_status', 'Estado no válido');
  const type = oneOf(InvoiceTypeFilterEnum, q.type, 'invalid_type', 'Tipo no válido');
  const payment = oneOf(
    InvoicePaymentFilterEnum,
    q.payment,
    'invalid_payment',
    'Forma de pago no válida',
  );
  const sort = oneOf(InvoiceSortEnum, q.sort, 'invalid_sort', 'Orden no válido');
  const from = day(q.from, 'desde');
  const to = day(q.to, 'hasta');
  return {
    ...(q.search ? { search: q.search } : {}),
    ...(q.facilityId ? { facilityId: q.facilityId } : {}),
    ...(status ? { status } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.contractId ? { contractId: q.contractId } : {}),
    ...(q.overdue === 'true' ? { overdue: true } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(type ? { type } : {}),
    ...(payment ? { payment } : {}),
    ...(sort ? { sort } : {}),
  };
}
