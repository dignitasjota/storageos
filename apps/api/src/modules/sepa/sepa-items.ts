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
  /** Un adeudo concreto, el motivo que da el banco y su código (AM04…). */
  opts: { itemId?: string; reason?: string; returnCode?: string | null } = {},
): Promise<void> {
  const item = await tx.sepaRemittanceItem.findFirst({
    where: { invoiceId, status: 'collected', ...(opts.itemId ? { id: opts.itemId } : {}) },
    orderBy: { id: 'desc' },
  });
  if (!item) return;
  await tx.sepaRemittanceItem.update({
    where: { id: item.id },
    data: {
      status: 'returned',
      failureReason: opts.reason ?? 'Devuelto por el banco',
      ...(opts.returnCode ? { returnCode: opts.returnCode } : {}),
    },
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

/**
 * Deshace `markSepaItemReturned` (la devolución se registró por error): el
 * adeudo vuelve a «cobrado» y, si era el primero del mandato, el siguiente ya
 * no se presenta como primero.
 */
export async function markSepaItemCollectedAgain(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  const item = await tx.sepaRemittanceItem.findFirst({
    where: {
      invoiceId,
      status: 'returned',
      failureReason: { startsWith: 'Devuelto por el banco' },
    },
    orderBy: { id: 'desc' },
  });
  if (!item) return;
  await tx.sepaRemittanceItem.update({
    where: { id: item.id },
    data: { status: 'collected', failureReason: null },
  });
  if (item.sequenceType !== 'FRST') return;
  await tx.sepaMandate.updateMany({
    where: { id: item.mandateId, status: 'active', sequenceType: 'FRST' },
    data: { sequenceType: 'RCUR' },
  });
}
