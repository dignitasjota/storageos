import { resolveCustomerEmailSettings } from '@storageos/shared';

import { renderCustomerEmail } from '../customer-emails.templates';

const base = {
  tenantName: 'Trasteros <García>',
  customerName: 'Lucía',
  portalUrl: 'https://garcia.es/portal/login',
};

describe('renderCustomerEmail', () => {
  it('factura emitida: importe en euros, vencimiento y enlace al área de clientes', () => {
    const r = renderCustomerEmail(base, {
      kind: 'invoice_issued',
      invoiceNumber: 'FA-2026-0007',
      total: 121,
      dueDate: new Date('2026-10-15T10:00:00Z'),
      payment: { via: 'manual', transferIban: null },
    });
    expect(r.subject).toBe('Nueva factura FA-2026-0007');
    expect(r.text).toContain('Hola Lucía,');
    expect(r.text).toMatch(/121,00\s€/);
    expect(r.text).toContain('Vencimiento: 15/10/2026');
    expect(r.text).toContain('https://garcia.es/portal/login');
    expect(r.text).toContain('Trasteros <García>');
  });

  it('factura emitida: explica cómo se va a pagar según el caso', () => {
    const issued = (
      payment: Parameters<typeof renderCustomerEmail>[1] extends infer D
        ? D extends { kind: 'invoice_issued'; payment: infer P }
          ? P
          : never
        : never,
    ) =>
      renderCustomerEmail(base, {
        kind: 'invoice_issued',
        invoiceNumber: 'FA-9',
        total: 50,
        dueDate: null,
        payment,
      });
    expect(issued({ via: 'auto_card', brand: 'visa', last4: '4242' }).text).toContain(
      'Te la cobraremos automáticamente en tu Visa terminada en 4242. No tienes que hacer nada.',
    );
    expect(issued({ via: 'auto_debit', last4: '3000' }).text).toContain(
      'Se cargará por domiciliación en tu cuenta terminada en 3000',
    );
    const sepa = issued({ via: 'sepa_remittance', last4: '1332' });
    expect(sepa.text).toContain('Antes del cargo te avisaremos de la fecha');
    expect(sepa.text).toContain('Ver mis facturas');
    const manual = issued({ via: 'manual', transferIban: 'ES9121000418450200051332' });
    expect(manual.text).toContain('IBAN: ES91 2100 0418 4502 0005 1332 · Concepto: FA-9');
    expect(manual.text).toContain('Pagar ahora');
  });

  it('el nombre del tenant se escapa en el HTML y no aparece la marca de la plataforma', () => {
    const r = renderCustomerEmail(base, {
      kind: 'payment_received',
      invoiceNumber: 'FA-1',
      amount: 50,
      paidAt: new Date('2026-10-01T10:00:00Z'),
    });
    expect(r.html).toContain('Trasteros &lt;García&gt;');
    expect(r.html).not.toContain('<García>');
    expect(r.html).not.toMatch(/TrasterOS|STORAGEOS/);
  });

  it('sin nombre del inquilino saluda sin nombre; cobro rechazado incluye el motivo', () => {
    const r = renderCustomerEmail(
      { ...base, customerName: '' },
      { kind: 'payment_failed', invoiceNumber: 'FA-2', amount: 30, reason: 'fondos insuficientes' },
    );
    expect(r.text.startsWith('Hola,')).toBe(true);
    expect(r.text).toContain('(fondos insuficientes)');
  });
});

describe('resolveCustomerEmailSettings', () => {
  it('todo activado por defecto; solo lo guardado como false se apaga', () => {
    expect(resolveCustomerEmailSettings({})).toEqual({
      invoice_issued: true,
      payment_received: true,
      payment_failed: true,
      contract_signed: true,
      contract_ending_soon: true,
      move_out_confirmed: true,
      sepa_prenotification: true,
    });
    expect(resolveCustomerEmailSettings({ invoice_issued: false }).invoice_issued).toBe(false);
    expect(resolveCustomerEmailSettings(null).payment_received).toBe(true);
  });
});

describe('renderCustomerEmail — preaviso SEPA', () => {
  it('incluye importe, fecha de cargo, últimos dígitos de la cuenta, acreedor y mandato', () => {
    const r = renderCustomerEmail(base, {
      kind: 'sepa_prenotification',
      invoiceNumber: 'FA-9',
      amount: 60.5,
      collectionDate: new Date('2026-11-05T00:00:00Z'),
      ibanLast4: '4321',
      mandateReference: 'MND-ABC',
      creditorName: 'Trasteros García SL',
      creditorId: 'ES12ZZZB12345678',
    });
    expect(r.subject).toMatch(/60,50\s€ el 05\/11\/2026/);
    expect(r.text).toContain('terminada en 4321');
    expect(r.text).toContain('ES12ZZZB12345678');
    expect(r.text).toContain('MND-ABC');
  });
});
