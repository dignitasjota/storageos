import type { InvoiceDto } from '@storageos/shared';

/**
 * Número que se enseña: un borrador (también uno cancelado) lleva un número
 * provisional `DRAFT-…` que no significa nada para nadie.
 */
export function invoiceNumberLabel(i: Pick<InvoiceDto, 'invoiceNumber'>): string {
  return i.invoiceNumber.startsWith('DRAFT-') ? 'Borrador' : i.invoiceNumber;
}

/** ¿Tiene ya su número de verdad (emitida alguna vez)? */
export function isNumbered(i: Pick<InvoiceDto, 'invoiceNumber'>): boolean {
  return !i.invoiceNumber.startsWith('DRAFT-');
}
