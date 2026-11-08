import type { Prisma } from '@storageos/database';

type Db = Pick<Prisma.TransactionClient, 'contract' | 'invoice'>;

/**
 * ¿Es la primera factura de una reserva online (desde la web o el área de
 * clientes) que aún está en su plazo para pagarse? Esa factura se paga en la
 * propia reserva y, si no se paga a tiempo, la reserva caduca y la factura se
 * anula. Por eso no se avisa de ella al emitirse: llega con el justificante al
 * pagarla.
 */
export async function isPendingOnlineBookingInvoice(
  db: Db,
  tenantId: string,
  invoiceId: string,
  contractId: string | null,
): Promise<boolean> {
  if (!contractId) return false;
  const contract = await db.contract.findFirst({
    where: { id: contractId, tenantId },
    select: { firstPaymentDeadline: true },
  });
  if (!contract?.firstPaymentDeadline) return false;
  const first = await db.invoice.findFirst({
    where: { tenantId, contractId, kind: 'invoice', deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return first?.id === invoiceId;
}
