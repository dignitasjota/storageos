import { describe, expect, it } from 'vitest';

import { buildSepaMandateDocument, mandateIsSigned, maskIban, sepaMandateText } from './mandate';

const base = {
  reference: 'MND-ABC123',
  creditor: {
    name: 'Trasteros SL',
    creditorId: 'ES97ZZZB12345678',
    address: 'Calle Mayor 1',
    postalCode: '46001',
    city: 'Valencia',
    country: 'ES',
  },
  debtor: { name: 'Ana', address: 'Sol 5', postalCode: '46002', city: 'Valencia', country: 'ES' },
  iban: 'ES9121000418450200051332',
  bic: null,
  prenoticeDays: 5,
  place: 'Valencia',
  date: '23 de octubre de 2026',
};

describe('mandato SEPA', () => {
  it('lleva los campos que exige el banco y el preaviso pactado', () => {
    const doc = buildSepaMandateDocument(base);
    const labels = doc.fields.map((f) => f.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Referencia de la orden de domiciliación',
        'Identificador del acreedor',
        'Nombre del acreedor',
        'Dirección del acreedor',
        'Nombre del deudor',
        'Dirección del deudor',
        'Número de cuenta (IBAN)',
        'Tipo de pago',
        'Lugar y fecha de la firma',
      ]),
    );
    expect(doc.clauses.join(' ')).toContain('al menos 5 días naturales');
    expect(sepaMandateText(doc)).not.toContain(base.iban);
  });

  it('enmascara el IBAN', () => {
    expect(maskIban('ES9121000418450200051332')).toBe('ES91 **** **** **** **** 1332');
  });

  it('cuenta como firmado el firmado aquí y el de papel', () => {
    expect(mandateIsSigned('signed')).toBe(true);
    expect(mandateIsSigned('external')).toBe(true);
    expect(mandateIsSigned('pending')).toBe(false);
  });
});
