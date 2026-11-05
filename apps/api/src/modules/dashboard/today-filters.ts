import type { Prisma } from '@storageos/database';

/**
 * Factura vencida: marcada como tal o emitida con el vencimiento ya pasado (el
 * cron las marca de madrugada). La misma definición en la bandeja de «Hoy» y en
 * las cifras del mes, para que enseñen el mismo importe.
 */
export function overdueInvoiceWhere(startOfToday: Date): Prisma.InvoiceWhereInput {
  return {
    kind: 'invoice',
    deletedAt: null,
    OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: startOfToday } }],
  };
}
