import { CUSTOMER_EMAIL_KINDS } from '@storageos/shared';

import { sampleCustomerEmailData, sampleCustomerName } from '../customer-email-samples';
import { renderCustomerEmail } from '../customer-emails.templates';

const ctx = (locale: 'es' | 'en') => ({
  locale,
  tenantName: 'Trasteros García',
  facilityName: 'Centro',
  unitCode: 'B-07',
  monthlyWithVat: 72.6,
  invoiceNumber: 'FA/2026/00042',
  contractNumber: 'CT-2026-0042',
  transferIban: 'ES9121000418450200051332',
  creditorName: 'Trasteros García SL',
  creditorId: 'ES97ZZZB12345678',
  bookingUrl: 'https://garcia.example/reservar',
  portalUrl: 'https://garcia.example/portal/login',
  now: new Date('2026-11-20T10:00:00Z'),
});

describe('vista previa de los correos al inquilino', () => {
  for (const locale of ['es', 'en'] as const) {
    it.each(CUSTOMER_EMAIL_KINDS)(`%s se pinta entero en ${locale}`, (kind) => {
      const email = renderCustomerEmail(
        {
          tenantName: 'Trasteros García',
          customerName: sampleCustomerName(locale),
          locale,
          logoUrl: null,
          brandColor: '#1E3A8A',
          portalUrl: 'https://garcia.example/portal/login',
        },
        sampleCustomerEmailData(kind, ctx(locale)),
      );
      expect(email.subject.length).toBeGreaterThan(5);
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/undefined|NaN|Invalid Date|\[object Object\]/);
      }
      expect(email.html).toContain('Trasteros García');
      expect(email.text).toContain(sampleCustomerName(locale));
    });
  }

  it('usa la cuota del negocio en la factura de ejemplo', () => {
    const data = sampleCustomerEmailData('invoice_issued', ctx('es'));
    expect(data).toMatchObject({ kind: 'invoice_issued', total: 72.6 });
  });
});
