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

  it('pago de la fianza: habla de justificante, no de factura', () => {
    const r = renderCustomerEmail(base, {
      kind: 'payment_received',
      invoiceNumber: 'FZ-CT-2026-00009',
      amount: 100,
      paidAt: new Date('2026-10-20T10:00:00Z'),
      depositReceipt: true,
    });
    expect(r.subject).toBe('Fianza recibida — justificante FZ-CT-2026-00009');
    expect(r.text).toMatch(/fianza de 100,00\s€/);
    expect(r.text).not.toContain('factura');
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
      first_payment_pending: true,
      contract_ending_soon: true,
      contract_renewed: true,
      contract_auto_renewal_notice: true,
      contract_price_change: true,
      deposit_settled: true,
      move_out_confirmed: true,
      sepa_prenotification: true,
      staff_message: true,
      unit_request_resolved: true,
      reservation_held: true,
      reservation_expiring: true,
      booking_expired: true,
    });
    expect(resolveCustomerEmailSettings({ invoice_issued: false }).invoice_issued).toBe(false);
    expect(resolveCustomerEmailSettings(null).payment_received).toBe(true);
  });
});

describe('renderCustomerEmail — primer pago pendiente', () => {
  const data = {
    kind: 'first_payment_pending' as const,
    contractNumber: 'CT-2026-00007',
    unitCode: 'A-12',
    facilityName: 'Local Centro',
    startDate: new Date('2026-11-16T00:00:00Z'),
    lines: [
      { description: 'Alquiler de noviembre', amount: 30.25 },
      { description: 'Protección de contenido', amount: 4.84 },
    ],
    deposit: 40,
    total: 75.09,
    deadline: new Date('2026-11-19T14:30:00Z'),
    payUrl: 'https://ejemplo.es/sign/abc.def',
  };
  const base = {
    tenantName: 'Trasteros García',
    customerName: 'Ana',
    locale: 'es' as const,
    logoUrl: null,
    brandColor: null,
    portalUrl: 'https://ejemplo.es/portal/login',
  };

  it('lleva el desglose, el total, el plazo en hora de España y el botón al enlace de la firma', () => {
    const email = renderCustomerEmail(base, data);
    expect(email.subject).toBe('Tu contrato CT-2026-00007 está firmado: falta el primer pago');
    expect(email.text).toMatch(/• Alquiler de noviembre: 30,25\s€/);
    expect(email.text).toMatch(/• Fianza: 40,00\s€/);
    expect(email.text).toMatch(/Total: 75,09\s€ \(IVA incluido\)\./);
    expect(email.text).toContain('antes del 19/11/2026 a las 15:30');
    expect(email.text).toContain('Pagar ahora: https://ejemplo.es/sign/abc.def');
    expect(email.html).toContain('href="https://ejemplo.es/sign/abc.def"');
  });

  it('sin fianza no la nombra y en inglés traduce el texto', () => {
    const email = renderCustomerEmail({ ...base, locale: 'en' }, { ...data, deposit: 0 });
    expect(email.subject).toContain('complete your first payment');
    expect(email.text).not.toContain('Deposit');
    expect(email.text).toContain('Pay now: https://ejemplo.es/sign/abc.def');
  });
});

describe('renderCustomerEmail — reserva online caducada', () => {
  const data = {
    kind: 'booking_expired' as const,
    unitCode: 'T12',
    facilityName: 'Centro',
    signed: true,
    invoiceCancelled: true,
    bookingUrl: 'https://trasteros.example/reservar?facilityId=f1&unitTypeId=t1',
  };

  it('dice que se canceló, que no hay nada que pagar y el botón lleva a reservar de nuevo', () => {
    const r = renderCustomerEmail(
      { tenantName: 'Trasteros García', customerName: 'Ana', portalUrl: 'https://x/portal' },
      data,
    );
    expect(r.subject).toBe('Tu reserva del trastero T12 se ha cancelado');
    expect(r.text).toContain('No hemos recibido el pago de tu reserva del trastero T12 en Centro');
    expect(r.text).toContain('No tienes que pagar nada');
    expect(r.text).toContain(`Volver a reservar: ${data.bookingUrl}`);
    expect(r.text).not.toContain('https://x/portal');
    expect(r.html).toContain(
      'href="https://trasteros.example/reservar?facilityId=f1&amp;unitTypeId=t1"',
    );
  });

  it('sin firmar: dice que no se terminó y no habla de factura', () => {
    const r = renderCustomerEmail(
      { tenantName: 'T', customerName: 'Ana', portalUrl: 'https://x/portal' },
      { ...data, signed: false, invoiceCancelled: false },
    );
    expect(r.text).toContain('no se terminó a tiempo (faltaba firmar el contrato y pagar)');
    expect(r.text).toContain('No tienes que pagar nada.');
    expect(r.text).not.toContain('factura');
  });

  it('en inglés si el inquilino tiene locale en', () => {
    const r = renderCustomerEmail(
      { tenantName: 'T', customerName: '', portalUrl: 'https://x/portal', locale: 'en' },
      data,
    );
    expect(r.subject).toBe('Your booking of storage unit T12 has been cancelled');
    expect(r.text).toContain(`Book again: ${data.bookingUrl}`);
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
      creditorId: 'ES97ZZZB12345678',
    });
    expect(r.subject).toMatch(/60,50\s€ el 05\/11\/2026/);
    expect(r.text).toContain('terminada en 4321');
    expect(r.text).toContain('ES97ZZZB12345678');
    expect(r.text).toContain('MND-ABC');
  });

  it('varias facturas del inquilino en la remesa: un aviso con todos los cargos', () => {
    const r = renderCustomerEmail(base, {
      kind: 'sepa_prenotification',
      invoiceNumber: 'FA-9',
      amount: 181.5,
      collectionDate: new Date('2026-11-05T00:00:00Z'),
      ibanLast4: '4321',
      mandateReference: 'MND-ABC',
      creditorName: 'Trasteros García SL',
      creditorId: 'ES97ZZZB12345678',
      invoices: [
        { number: 'FA-9', amount: 60.5 },
        { number: 'FA-10', amount: 121 },
      ],
    });
    expect(r.subject).toMatch(/181,50\s€ el 05\/11\/2026/);
    expect(r.text).toMatch(/en 2 cargos: factura FA-9 \(60,50\s€\), factura FA-10 \(121,00\s€\)/);
  });

  it('en inglés si el inquilino tiene locale en', () => {
    const r = renderCustomerEmail(
      { ...base, locale: 'en' },
      {
        kind: 'invoice_issued',
        invoiceNumber: 'FA-1',
        total: 121,
        dueDate: new Date('2026-10-15T10:00:00Z'),
        payment: { via: 'manual', transferIban: 'ES9121000418450200051332' },
      },
    );
    expect(r.subject).toBe('New invoice FA-1');
    expect(r.text).toContain('Hello Lucía,');
    expect(r.text).toContain('for €121.00');
    expect(r.text).toContain('Due date: 15/10/2026');
    expect(r.text).toContain('Reference: FA-1');
    expect(r.text).toContain('Pay now');
    expect(r.text).toContain('Kind regards,');
    expect(r.text).not.toMatch(/Hola|Vencimiento|Un saludo/);
  });
});
