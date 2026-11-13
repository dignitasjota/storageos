import type { InvoiceDto } from '@storageos/shared';

/**
 * Número que se enseña: un borrador (también uno cancelado) lleva un número
 * provisional `DRAFT-…` que no significa nada para nadie.
 */
export function invoiceNumberLabel(
  i: Pick<InvoiceDto, 'invoiceNumber'> & Partial<Pick<InvoiceDto, 'issueOnPayment'>>,
): string {
  if (!i.invoiceNumber.startsWith('DRAFT-')) return i.invoiceNumber;
  // Primer pago de una reserva online: se numera al cobrarse.
  return i.issueOnPayment ? 'Primer pago' : 'Borrador';
}

/** ¿Tiene ya su número de verdad (emitida alguna vez)? */
export function isNumbered(i: Pick<InvoiceDto, 'invoiceNumber'>): boolean {
  return !i.invoiceNumber.startsWith('DRAFT-');
}
