import { buildSepaMandateDocument, sepaMandateText } from '@storageos/shared';

import { parseStoredDocument, renderMandateHtml } from '../sepa-mandate-html';

describe('mandato SEPA firmado (PDF)', () => {
  const doc = buildSepaMandateDocument({
    reference: 'MND-1',
    creditor: {
      name: 'Trasteros & Co',
      creditorId: 'ES12ZZZB12345678',
      address: 'Mayor 1',
      postalCode: '46001',
      city: 'Valencia',
      country: 'ES',
    },
    debtor: { name: 'Ana', address: 'Sol 5', postalCode: '46002', city: 'Valencia', country: 'ES' },
    iban: 'ES9121000418450200051332',
    bic: null,
    prenoticeDays: 14,
    place: 'Valencia',
    date: '1 de enero de 2027',
  });

  it('el texto guardado se vuelve a leer igual', () => {
    expect(parseStoredDocument(sepaMandateText(doc))).toEqual(doc);
  });

  it('el HTML lleva la constancia y escapa el texto', () => {
    const html = renderMandateHtml(doc, {
      signerName: 'Ana <b>',
      method: 'typed',
      signatureImage: null,
      typedSignature: 'Ana',
      signedAt: new Date('2027-01-01T10:00:00Z'),
      ip: '1.2.3.4',
      userAgent: 'test',
      documentHash: 'abc',
    });
    expect(html).toContain('Trasteros &amp; Co');
    expect(html).toContain('Ana &lt;b&gt;');
    expect(html).toContain('1.2.3.4');
    expect(html).toContain('SHA-256): abc');
  });
});
