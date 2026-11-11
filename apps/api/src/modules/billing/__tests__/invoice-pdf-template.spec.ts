import {
  invoiceBreakdown,
  invoiceDocTitle,
  paymentLines,
  renderInvoiceHtml,
} from '../invoice-pdf-template';

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
    aeatMessage: null,
    holdedDocumentId: null,
    issuedBy: 'app',
    paidAt: null,
    cancelledAt: null,
    voidedAt: null,
    voidReason: null,
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

  it('el QR va al principio, con «QR tributario:» encima y la frase debajo', () => {
    const html = renderInvoiceHtml({
      invoice: invoice({ qrCodeUrl: 'data:image/png;base64,QR', aeatCsv: 'A-1' }),
      issuer,
      customer: null,
    });
    const label = html.indexOf('QR tributario:');
    const img = html.indexOf('data:image/png;base64,QR');
    const legend = html.indexOf('Factura verificable en la sede electrónica de la AEAT');
    expect(label).toBeGreaterThan(-1);
    expect(label).toBeLessThan(img);
    expect(img).toBeLessThan(legend);
    // Antes del contenido de la factura (emisor, cliente, líneas).
    expect(legend).toBeLessThan(html.indexOf('Emisor'));
    expect(html).toContain('<header class="with-qr">');
    expect(html).toContain('CSV de la AEAT: A-1');
  });

  it('sin Veri*Factu: ni QR, ni la frase, ni la huella', () => {
    const plain = renderInvoiceHtml({
      invoice: invoice({ hash: null, qrCodeUrl: null }),
      issuer,
      customer: null,
    });
    expect(plain).not.toContain('QR tributario');
    expect(plain).not.toContain('verificable');
    expect(plain).not.toContain('Huella');
    expect(plain).toContain('<header>');
    // Un QR que no es una imagen PNG en línea no se pinta.
    const bad = renderInvoiceHtml({
      invoice: invoice({ qrCodeUrl: 'https://evil.test/qr.png' }),
      issuer,
      customer: null,
    });
    expect(bad).not.toContain('evil.test');
    expect(bad).not.toContain('QR tributario');
  });

  it('sin cobros ni forma de pago no dice lo que falta', () => {
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

  it('pagada: sello con el día y la forma, sin la caja de cómo pagar', () => {
    const html = renderInvoiceHtml({
      invoice: invoice({ status: 'paid', amountPaid: 171, amountPending: 0 }),
      issuer,
      customer: null,
      payment: { via: 'manual', transferIban: 'ES9121000418450200051332' },
      paid: { at: '2026-11-08', method: 'bank_transfer' },
    });
    expect(html).toContain('PAGADA');
    expect(html).toContain('08/11/2026 · transferencia');
    expect(html).not.toContain('Forma de pago');
  });

  it('anulada por error: sello «ANULADA» y sin vencimiento ni forma de pago', () => {
    const html = renderInvoiceHtml({
      invoice: invoice({
        status: 'cancelled',
        voidedAt: '2026-11-08T10:00:00.000Z',
        voidReason: 'Factura de prueba',
      }),
      issuer,
      customer: null,
      payment: { via: 'manual', transferIban: 'ES9121000418450200051332' },
    });
    expect(html).toContain('ANULADA');
    expect(html).toContain('08/11/2026 · emitida por error');
    expect(html).not.toContain('Vencimiento:');
    expect(html).not.toContain('Forma de pago');
    expect(html).not.toContain('PAGADA');
  });

  it('pendiente: dice cómo pagarla', () => {
    const html = renderInvoiceHtml({
      invoice: invoice(),
      issuer,
      customer: null,
      payment: { via: 'manual', transferIban: 'ES9121000418450200051332' },
    });
    expect(html).toContain('Forma de pago');
    expect(html).toContain('ES91 2100 0418 4502 0005 1332');
    expect(html).toContain('indicando FA/2026/00007');
    expect(html).not.toContain('PAGADA');
    // Anulada o rectificativa: no se paga.
    const cancelled = renderInvoiceHtml({
      invoice: invoice({ status: 'rectified' }),
      issuer,
      customer: null,
      payment: { via: 'manual', transferIban: null },
    });
    expect(cancelled).not.toContain('Forma de pago');
  });

  it('las frases de cada forma de pago', () => {
    expect(paymentLines({ via: 'auto_card', brand: 'Visa', last4: '4242' }, 'F1')).toEqual([
      'Se cobrará automáticamente en la tarjeta Visa terminada en 4242.',
    ]);
    expect(paymentLines({ via: 'auto_debit', last4: '1332' }, 'F1')).toEqual([
      'Se cargará por domiciliación en la cuenta terminada en 1332.',
    ]);
    expect(paymentLines({ via: 'sepa_remittance', last4: '0001' }, 'F1')).toEqual([
      'Se cobrará por domiciliación en la cuenta terminada en 0001.',
    ]);
    expect(paymentLines({ via: 'manual', transferIban: null }, 'F1')).toEqual([
      'Puedes pagarla desde tu área de clientes.',
    ]);
  });

  it('el logo solo como imagen incrustada y el color solo en #rrggbb', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const ok = renderInvoiceHtml({
      invoice: invoice(),
      issuer,
      customer: null,
      logo: png,
      brandColor: '#1E3A8A',
    });
    expect(ok).toContain(`<img class="logo" src="${png}"`);
    expect(ok).toContain('#1E3A8A');
    const bad = renderInvoiceHtml({
      invoice: invoice(),
      issuer,
      customer: null,
      logo: 'https://evil.test/x.png',
      brandColor: 'red;}</style><script>',
    });
    expect(bad).not.toContain('<img class="logo"');
    expect(bad).not.toContain('evil.test');
    expect(bad).not.toContain('<script>');
  });
});
