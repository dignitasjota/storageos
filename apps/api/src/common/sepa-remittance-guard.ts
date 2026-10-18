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

/**
 * Filtro Prisma de facturas que NO tienen un cobro en marcha: ni un pago por
 * pasarela en curso (`pending`/`processing`, p. ej. un adeudo SEPA que liquida
 * en días) ni un adeudo en una remesa SEPA sin confirmar. Lo usan el control de
 * impagos y la caducidad de las reservas online para no reclamar, recargar,
 * cortar el acceso ni cancelar algo que el inquilino ya está pagando.
 */
export const NO_PAYMENT_IN_FLIGHT = {
  payments: { none: { status: { in: ['pending', 'processing'] } } },
  sepaRemittanceItems: { none: { status: 'pending' } },
} satisfies Prisma.InvoiceWhereInput;

/** ¿Tiene la factura un cobro en marcha (pasarela en curso o remesa SEPA pendiente)? */
export async function hasPaymentInFlight(
  db: Pick<Prisma.TransactionClient, 'invoice'>,
  invoiceId: string,
): Promise<boolean> {
  const settled = await db.invoice.count({ where: { id: invoiceId, ...NO_PAYMENT_IN_FLIGHT } });
  return settled === 0;
}
