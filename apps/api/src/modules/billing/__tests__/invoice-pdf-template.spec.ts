import { invoiceBreakdown, invoiceDocTitle, renderInvoiceHtml } from '../invoice-pdf-template';

import type { InvoiceDto } from '@storageos/shared';

function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: 'inv-1',
    invoiceNumber: 'FA/2026/00007',
    seriesId: 's',
    seriesCode: 'A',
    sequenceNumber: 7,
    customerId: 'c-1',
    customerName: 'Ana García',
    contractId: null,
    contractNumber: null,
    unitId: null,
    unitCode: null,
    facilityId: null,
    facilityName: null,
    offlinePaymentMethod: null,
    status: 'issued',
    invoiceType: 'F1',
    kind: 'invoice',
    bundledWithInvoiceId: null,
    rectifiesInvoiceId: null,
    rectifiesInvoiceNumber: null,
    rectifiesInvoiceDate: null,
    rectifiedBy: [],
    rectificationReason: null,
    lateFeeForInvoiceId: null,
    lateFeeInvoiceId: null,
    correctionMethod: null,
    issueDate: '2026-11-07',
    dueDate: '2026-11-22',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    subtotal: 150,
    taxAmount: 21,
    total: 171,
    amountPaid: 50,
    amountRefunded: 0,
    ownerId: null,
    ownerName: null,
    withholdingPct: 0,
    withholdingAmount: 0,
    amountDue: 171,
    amountPending: 121,
    amountCompensated: 0,
    currency: 'EUR',
    hasPdf: false,
    notes: null,
    hash: 'abc',
    previousHash: null,
    qrCodeUrl: null,
    verifactuMode: 'verifactu',
    aeatSentAt: null,
    aeatStatus: null,
    aeatCsv: null,
    holdedDocumentId: null,
    issuedBy: 'app',
    paidAt: null,
    cancelledAt: null,
    items: [
      {
        id: 'l1',
        description: 'Alquiler <T12>',
        quantity: 1,
        unitPrice: 100,
        taxRate: 21,
        taxCategory: 'S1',
        taxAmount: 21,
        total: 121,
        relatedContractId: null,
        relatedUnitId: null,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        position: 0,
      },
      {
        id: 'l2',
        description: 'Recargo por mora',
        quantity: 1,
        unitPrice: 50,
        taxRate: 0,
        taxCategory: 'N1',
        taxAmount: 0,
        total: 50,
        relatedContractId: null,
        relatedUnitId: null,
        periodStart: null,
        periodEnd: null,
        position: 1,
      },
    ],
    createdAt: '2026-11-07T10:00:00Z',
    updatedAt: '2026-11-07T10:00:00Z',
    ...overrides,
  };
}

const issuer = {
  name: 'Trasteros García',
  legalName: 'Trasteros García SL',
  taxId: 'B12345674',
  country: 'ES',
  billingEmail: 'hola@garcia.test',
  address: 'Calle Mayor 1, 28001 Madrid',
};

describe('PDF de la factura', () => {
  it('pone el título según lo que es', () => {
    expect(invoiceDocTitle({ kind: 'invoice', invoiceType: 'F1' })).toBe('Factura');
    expect(invoiceDocTitle({ kind: 'invoice', invoiceType: 'F2' })).toBe('Factura simplificada');
    expect(invoiceDocTitle({ kind: 'invoice', invoiceType: 'R4' })).toBe('Factura rectificativa');
    expect(invoiceDocTitle({ kind: 'deposit_receipt', invoiceType: 'F1' })).toBe(
      'Justificante de fianza',
    );
  });

  it('separa lo que lleva IVA de lo no sujeto', () => {
    const b = invoiceBreakdown(invoice().items);
    expect(b.taxed).toEqual([{ rate: 21, base: 100, tax: 21 }]);
    expect(b.notSubject).toBe(50);
    expect(b.exempt).toBe(0);
  });

  it('no dice si está pagada ni lo que falta: el PDF no cambia', () => {
    const html = renderInvoiceHtml({ invoice: invoice(), issuer, customer: null });
    expect(html).not.toContain('Pendiente');
    expect(html).not.toContain('Pagado');
    expect(html).toContain('Base imponible 21 %');
    expect(html).toContain('No sujeto');
    expect(html).toContain('07/11/2026');
    expect(html).toContain('Del 01/11/2026 al 30/11/2026');
    expect(html).toContain('Cliente no identificado');
    // Escapa lo que escribe el negocio.
    expect(html).toContain('Alquiler &lt;T12&gt;');
  });

  it('en una rectificativa dice a qué factura rectifica y por qué', () => {
    const html = renderInvoiceHtml({
      invoice: invoice({
        invoiceNumber: 'FR/2026/00002',
        invoiceType: 'R4',
        rectifiesInvoiceId: 'orig',
        rectifiesInvoiceNumber: 'FA/2026/00001',
        rectifiesInvoiceDate: '2026-10-01',
        rectificationReason: 'Importe equivocado',
        correctionMethod: 'by_differences',
        total: -121,
      }),
      issuer,
      customer: null,
    });
    expect(html).toContain('<h1>Factura rectificativa</h1>');
    expect(html).toContain('Rectifica la factura FA/2026/00001 de 01/10/2026');
    expect(html).toContain('Motivo: Importe equivocado');
    expect(html).toContain('por diferencias');
    expect(html).not.toContain('Vencimiento');
  });

  it('quita la justificación de la simplificada de las notas', () => {
    const html = renderInvoiceHtml({
      invoice: invoice({ invoiceType: 'F2', notes: '[F2:other] Venta en mostrador' }),
      issuer,
      customer: null,
    });
    expect(html).toContain('<h1>Factura simplificada</h1>');
    expect(html).toContain('Venta en mostrador');
    expect(html).not.toContain('[F2:');
  });
});
