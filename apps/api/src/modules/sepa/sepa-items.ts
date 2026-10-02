import type { Prisma } from '@storageos/database';

/**
 * El banco devolvió un adeudo ya cobrado: el adeudo pasa a «devuelto» (la
 * factura puede presentarse en otra remesa). Si era el primer cobro del
 * mandato (FRST) y no le queda ningún otro cobrado, el mandato vuelve a FRST:
 * el siguiente adeudo debe presentarse como primero.
 */
export async function markSepaItemReturned(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  const item = await tx.sepaRemittanceItem.findFirst({
    where: { invoiceId, status: 'collected' },
    orderBy: { id: 'desc' },
  });
  if (!item) return;
  await tx.sepaRemittanceItem.update({
    where: { id: item.id },
    data: { status: 'returned', failureReason: 'Devuelto por el banco' },
  });
  if (item.sequenceType !== 'FRST') return;
  const stillCollected = await tx.sepaRemittanceItem.count({
    where: { mandateId: item.mandateId, status: 'collected' },
  });
  if (stillCollected === 0) {
    await tx.sepaMandate.updateMany({
      where: { id: item.mandateId, status: 'active' },
      data: { sequenceType: 'FRST' },
    });
  }
}
