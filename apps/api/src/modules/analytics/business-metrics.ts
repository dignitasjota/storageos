import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import { todayInTimezone, zonedDayStart } from '../../common/format';

import {
  contractLifecycle,
  contractWhere,
  invoiceWhere,
  LIFECYCLE_SELECT,
  SIGNED_CONTRACT_WHERE,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';

import type { Prisma } from '@storageos/database';
import type { AgingBucketRange, ReceivablesDto } from '@storageos/shared';

/**
 * Definición única de las cifras del negocio. El Resumen, «Hoy» y Analítica las
 * calculan con estas funciones para que una misma cifra no cambie de pantalla.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function tenantTimezone(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<string> {
  const row = await tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } });
  return row?.timezone ?? 'Europe/Madrid';
}

/** Comienzo de un mes en la zona del negocio. `month` va de 1 a 12 y puede desbordar. */
export function zonedMonthStart(year: number, month: number, timezone: string): Date {
  return zonedDayStart(new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10), timezone);
}

/** Año y mes en curso en la zona del negocio. */
export function currentYearMonth(timezone: string, now = new Date()) {
  const today = todayInTimezone(timezone, now);
  return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, today };
}

/** Clave AAAA-MM de un instante en la zona del negocio. */
export function zonedMonthKey(date: Date, timezone: string): string {
  return todayInTimezone(timezone, date).toISOString().slice(0, 7);
}

// --- Trasteros ---------------------------------------------------------------

type UnitCount = Record<string, number>;

export interface UnitCounts {
  total: number;
  occupied: number;
  reserved: number;
  available: number;
  outOfService: number;
  byStatus: UnitCount;
  byFacility: Map<string, UnitCount>;
}

/** Trasteros en manos del inquilino de prueba: para las cifras siguen libres. */
export async function testRunUnits(
  tx: Prisma.TransactionClient,
  where: Prisma.UnitWhereInput,
): Promise<{ id: string; facilityId: string; status: string }[]> {
  const rows = await tx.contract.findMany({
    where: {
      status: { in: ['draft', 'active', 'ending'] },
      deletedAt: null,
      customer: { isTest: true },
      unit: where,
    },
    select: { unit: { select: { id: true, facilityId: true, status: true } } },
  });
  return rows.map((r) => r.unit);
}

export async function unitCounts(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
): Promise<UnitCounts> {
  const where = unitWhere(scope);
  const [rows, testUnits] = await Promise.all([
    tx.unit.groupBy({ by: ['facilityId', 'status'], where, _count: { _all: true } }),
    testRunUnits(tx, where),
  ]);

  const byFacility = new Map<string, UnitCount>();
  const add = (facilityId: string, status: string, n: number) => {
    const counts = byFacility.get(facilityId) ?? {};
    counts[status] = (counts[status] ?? 0) + n;
    byFacility.set(facilityId, counts);
  };
  for (const row of rows) add(row.facilityId, row.status, row._count._all);
  for (const unit of testUnits) {
    if (unit.status !== 'occupied' && unit.status !== 'reserved') continue;
    add(unit.facilityId, unit.status, -1);
    add(unit.facilityId, 'available', 1);
  }

  const byStatus: UnitCount = {};
  for (const counts of byFacility.values()) {
    for (const [status, n] of Object.entries(counts)) {
      byStatus[status] = (byStatus[status] ?? 0) + n;
    }
  }
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const occupied = byStatus.occupied ?? 0;
  const reserved = byStatus.reserved ?? 0;
  const available = byStatus.available ?? 0;
  return {
    total,
    occupied,
    reserved,
    available,
    outOfService: total - occupied - reserved - available,
    byStatus,
    byFacility,
  };
}

// --- Facturado y cobrado -----------------------------------------------------

/**
 * Lo facturado cuenta las rectificadas y sus abonos (anular suma cero en total);
 * la sustitutiva cuenta solo la diferencia con la factura que sustituye, igual
 * que en los libros fiscales.
 */
export const INVOICED_STATUSES = [
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
  'rectified',
] as const;

export const INVOICED_SELECT = {
  issueDate: true,
  total: true,
  correctionMethod: true,
  rectifiesInvoice: { select: { total: true } },
} as const;

export function invoicedAmount(row: {
  total: Prisma.Decimal | number;
  correctionMethod: string | null;
  rectifiesInvoice: { total: Prisma.Decimal | number } | null;
}): number {
  const total = Number(row.total);
  if (row.correctionMethod === 'by_substitution' && row.rectifiesInvoice) {
    return total - Number(row.rectifiesInvoice.total);
  }
  return total;
}

export function invoicedWhere(scope: AnalyticsScope, from: Date, to: Date) {
  return {
    deletedAt: null,
    status: { in: [...INVOICED_STATUSES] },
    // La fianza no es un ingreso (se devuelve): fuera de lo facturado y cobrado.
    kind: 'invoice',
    issueDate: { gte: from, lt: to },
    ...invoiceWhere(scope),
  } satisfies Prisma.InvoiceWhereInput;
}

/** Facturado entre dos días (`from` incluido, `to` no). */
export async function invoicedBetween(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await tx.invoice.findMany({
    where: invoicedWhere(scope, from, to),
    select: INVOICED_SELECT,
  });
  return round2(rows.reduce((sum, r) => sum + invoicedAmount(r), 0));
}

/** Cobros reales: sin fianzas ni compensaciones con abonos. */
export function collectedWhere(scope: AnalyticsScope, from: Date, to: Date) {
  return {
    status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
    paidAt: { gte: from, lt: to },
    invoice: { kind: 'invoice', ...invoiceWhere(scope) },
    methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
  } satisfies Prisma.PaymentWhereInput;
}

/** Cobrado entre dos instantes, neto de devoluciones. */
export async function collectedBetween(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<number> {
  const agg = await tx.payment.aggregate({
    where: collectedWhere(scope, from, to),
    _sum: { amount: true, refundedAmount: true },
  });
  return round2(Number(agg._sum.amount ?? 0) - Number(agg._sum.refundedAmount ?? 0));
}

// --- Por cobrar --------------------------------------------------------------

function agingRange(days: number): AgingBucketRange {
  if (days < 30) return '0-30';
  if (days < 60) return '30-60';
  if (days < 90) return '60-90';
  return '+90';
}

/**
 * Lo emitido sin cobrar a un día dado, separando lo vencido (por tramos) de lo
 * que aún está en plazo. Vencida = con el vencimiento pasado, la haya marcado ya
 * o no la tarea de la noche.
 */
export async function receivables(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
  at: Date,
): Promise<ReceivablesDto> {
  const rows = await tx.invoice.findMany({
    where: {
      status: { in: ['issued', 'overdue', 'partially_refunded'] },
      deletedAt: null,
      kind: 'invoice',
      ...invoiceWhere(scope),
    },
    select: { dueDate: true, total: true, amountPaid: true },
  });

  const order: AgingBucketRange[] = ['0-30', '30-60', '60-90', '+90'];
  const buckets = new Map(order.map((range) => [range, { amount: 0, invoiceCount: 0 }]));
  let total = 0;
  let overdue = 0;
  let invoices = 0;
  let overdueInvoices = 0;
  for (const row of rows) {
    const pending = Number(row.total) - Number(row.amountPaid);
    if (pending <= 0) continue;
    total += pending;
    invoices += 1;
    if (!row.dueDate || row.dueDate >= at) continue;
    overdue += pending;
    overdueInvoices += 1;
    const days = Math.floor((at.getTime() - row.dueDate.getTime()) / 86_400_000);
    const bucket = buckets.get(agingRange(days))!;
    bucket.amount += pending;
    bucket.invoiceCount += 1;
  }

  return {
    total: round2(total),
    overdue: round2(overdue),
    notDue: round2(total - overdue),
    invoices,
    overdueInvoices,
    buckets: order.map((range) => {
      const b = buckets.get(range)!;
      return { range, amount: round2(b.amount), invoiceCount: b.invoiceCount };
    }),
  };
}

// --- Altas y bajas -----------------------------------------------------------

/** Altas y bajas entre dos instantes, con el criterio de Analítica → Bajas. */
export async function contractMoves(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<{ moveIns: number; moveOuts: number }> {
  const range = { gte: from, lt: to };
  const rows = await tx.contract.findMany({
    where: {
      AND: [
        SIGNED_CONTRACT_WHERE,
        contractWhere(scope),
        {
          OR: [
            { signedAt: range },
            { startDate: range },
            { endedAt: range },
            { cancelledAt: range },
          ],
        },
      ],
    },
    select: LIFECYCLE_SELECT,
  });
  let moveIns = 0;
  let moveOuts = 0;
  for (const row of rows) {
    const life = contractLifecycle(row);
    if (!life) continue;
    if (life.begin >= from && life.begin < to) moveIns += 1;
    if (life.end && life.end >= from && life.end < to) moveOuts += 1;
  }
  return { moveIns, moveOuts };
}

/** Inquilinos cuyo primer contrato empezó entre dos instantes. */
export async function newCustomers(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await tx.contract.findMany({
    where: { AND: [SIGNED_CONTRACT_WHERE, contractWhere(scope)] },
    select: { ...LIFECYCLE_SELECT, customerId: true },
  });
  const firstBegin = new Map<string, number>();
  for (const row of rows) {
    const begin = contractLifecycle(row)?.begin.getTime();
    if (begin === undefined) continue;
    const seen = firstBegin.get(row.customerId);
    if (seen === undefined || begin < seen) firstBegin.set(row.customerId, begin);
  }
  return [...firstBegin.values()].filter((t) => t >= from.getTime() && t < to.getTime()).length;
}
