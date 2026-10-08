import { containsInvoiceNumber, uniqueAutoMatch } from '../bank-reconciliation.service';

const tx = (description: string) => ({
  reference1: null,
  reference2: null,
  documentNumber: null,
  description,
});

describe('conciliación automática N43', () => {
  it('busca el número de factura como palabra suelta', () => {
    expect(containsInvoiceNumber('PAGO FACTURA F-2026-0012 GRACIAS', 'F-2026-0012')).toBe(true);
    expect(containsInvoiceNumber('pago f-2026-0012', 'F-2026-0012')).toBe(true);
    expect(containsInvoiceNumber('PAGO F-2026-00123', 'F-2026-0012')).toBe(false);
    expect(containsInvoiceNumber('XF-2026-0012', 'F-2026-0012')).toBe(false);
    expect(containsInvoiceNumber('TRANSFERENCIA', 'F-2026-0012')).toBe(false);
  });

  it('solo casa con importe exacto y número en el texto', () => {
    const candidates = [
      { id: 'a', invoiceNumber: 'F-2026-0001', amountPendingCents: 12100 },
      { id: 'b', invoiceNumber: 'F-2026-0002', amountPendingCents: 12100 },
      { id: 'c', invoiceNumber: 'F-2026-0003', amountPendingCents: 5000 },
    ];
    expect(uniqueAutoMatch(12100, tx('PAGO F-2026-0001'), candidates).map((c) => c.id)).toEqual([
      'a',
    ]);
    // Mismo importe sin número: varias posibles → ninguna automática.
    expect(uniqueAutoMatch(12100, tx('TRANSFERENCIA'), candidates)).toEqual([]);
    // Número correcto pero importe distinto (pago parcial): a mano.
    expect(uniqueAutoMatch(4000, tx('PAGO F-2026-0003'), candidates)).toEqual([]);
  });
});
