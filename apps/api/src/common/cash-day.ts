import { ConflictException } from '@nestjs/common';

import { todayInTimezone } from './format';

import type { Prisma } from '@storageos/database';

/**
 * Cierre de caja: un día cerrado no admite movimientos de efectivo nuevos (un
 * cobro, una devolución o una fianza en metálico) ni cambios en los que ya
 * tiene. Para registrarlos hay que reabrir el cierre (queda de constancia).
 *
 * La caja global de un día cubre todo el efectivo del negocio; la de un local,
 * solo el suyo. Un movimiento de un local está cerrado si lo está su caja o la
 * global; uno sin local (factura simplificada suelta), si lo está la global.
 */

/** El local al que se imputa una factura: su contrato, su venta o el suyo propio. */
export async function invoiceFacilityId(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<string | null> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      facilityId: true,
      contract: { select: { unit: { select: { facilityId: true } } } },
      productSale: { select: { facilityId: true } },
    },
  });
  return (
    invoice?.contract?.unit?.facilityId ??
    invoice?.productSale?.facilityId ??
    invoice?.facilityId ??
    null
  );
}

/** Días (fechas DATE a medianoche UTC) de esos instantes en la zona del negocio. */
export async function cashDays(
  tx: Prisma.TransactionClient,
  tenantId: string,
  at: (Date | null | undefined)[],
): Promise<Date[]> {
  const instants = at.filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  if (instants.length === 0) return [];
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const tz = tenant?.timezone ?? 'Europe/Madrid';
  const days = new Set(instants.map((d) => todayInTimezone(tz, d).getTime()));
  return [...days].map((t) => new Date(t));
}

/** 409 `cash_day_closed` si alguno de esos días tiene la caja cerrada. */
export async function assertCashDayOpen(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    facilityId: string | null;
    /** Instantes del movimiento (cuándo se cobró, cuándo se devolvió…). */
    at: (Date | null | undefined)[];
    /** Qué se intenta hacer, para el mensaje («un cobro en efectivo»). */
    what?: string;
  },
): Promise<void> {
  const days = await cashDays(tx, args.tenantId, args.at);
  if (days.length === 0) return;
  const closed = await tx.cashClosure.findFirst({
    where: {
      tenantId: args.tenantId,
      closureDate: { in: days },
      reopenedAt: null,
      OR: [{ facilityId: null }, ...(args.facilityId ? [{ facilityId: args.facilityId }] : [])],
    },
    select: { id: true, closureDate: true, facilityId: true },
    orderBy: { closureDate: 'asc' },
  });
  if (!closed) return;
  const day = closed.closureDate.toISOString().slice(0, 10).split('-').reverse().join('/');
  throw new ConflictException({
    code: 'cash_day_closed',
    message: `La caja del ${day} ya está cerrada: ${args.what ?? 'un movimiento en efectivo'} de ese día no se puede registrar ni cambiar. Si hace falta, reabre el cierre en Cierre de caja.`,
    details: {
      closureId: closed.id,
      closureDate: closed.closureDate.toISOString().slice(0, 10),
      facilityId: closed.facilityId,
    },
  });
}
