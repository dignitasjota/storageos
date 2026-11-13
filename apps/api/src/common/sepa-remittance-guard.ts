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

/**
 * Factura que se puede pagar ya: emitida o vencida, o el borrador del primer
 * pago de una reserva online (la factura se emite al cobrarse). Va como `OR`:
 * si la consulta ya lleva otro, se combina dentro de un `AND`.
 */
export const PAYABLE_INVOICE_WHERE = {
  OR: [{ status: { in: ['issued', 'overdue'] } }, { status: 'draft', issueOnPayment: true }],
} satisfies Prisma.InvoiceWhereInput;

/** ¿Tiene la factura un cobro en marcha (pasarela en curso o remesa SEPA pendiente)? */
export async function hasPaymentInFlight(
  db: Pick<Prisma.TransactionClient, 'invoice'>,
  invoiceId: string,
): Promise<boolean> {
  const settled = await db.invoice.count({ where: { id: invoiceId, ...NO_PAYMENT_IN_FLIGHT } });
  return settled === 0;
}

/**
 * Mandato con el que de verdad se puede cobrar: uno pendiente de firma no entra
 * en ninguna remesa.
 */
export const CHARGEABLE_MANDATE_WHERE = {
  status: 'active',
  signatureStatus: { in: ['signed', 'external'] },
};
