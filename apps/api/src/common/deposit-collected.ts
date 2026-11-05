import type { Prisma } from '@storageos/database';

/**
 * ¿Se cobró de verdad la fianza de este contrato? `deposit_status = held` solo
 * dice que el contrato lleva fianza desde que se firmó. Cuenta como cobrada el
 * justificante pagado, una factura pagada con línea «Fianza» (contratos antiguos)
 * o un contrato migrado de otro sistema con la fianza ya cobrada.
 */
export async function depositWasCollected(
  tx: Prisma.TransactionClient,
  contractId: string,
): Promise<boolean> {
  const [paid, migrated] = await Promise.all([
    tx.invoice.count({
      where: {
        contractId,
        deletedAt: null,
        status: { in: ['paid', 'partially_refunded', 'refunded'] },
        OR: [
          { kind: 'deposit_receipt' },
          { items: { some: { description: { startsWith: 'Fianza' } } } },
        ],
      },
    }),
    tx.contractEvent.count({
      where: { contractId, eventType: 'signed', payload: { path: ['migrated'], equals: true } },
    }),
  ]);
  return paid > 0 || migrated > 0;
}
