import { ConflictException } from '@nestjs/common';

import type { Prisma } from '@storageos/database';

/**
 * La factura está en una remesa SEPA generada y sin confirmar: el banco la
 * cobrará; cobrarla por otra vía la cobraría dos veces. Hay que esperar a
 * confirmar la remesa o cancelarla antes (409 `invoice_in_sepa_remittance`).
 */
export async function assertNotInSepaRemittance(
  db: Pick<Prisma.TransactionClient, 'sepaRemittanceItem'>,
  invoiceId: string,
): Promise<void> {
  const item = await db.sepaRemittanceItem.findFirst({
    where: { invoiceId, status: 'pending' },
    select: { remittance: { select: { name: true } } },
  });
  if (item) {
    throw new ConflictException({
      code: 'invoice_in_sepa_remittance',
      message: `La factura está en la remesa SEPA «${item.remittance.name}», pendiente de confirmar. El banco la cobrará: confirma o cancela la remesa antes de cobrarla de otra forma.`,
    });
  }
}
