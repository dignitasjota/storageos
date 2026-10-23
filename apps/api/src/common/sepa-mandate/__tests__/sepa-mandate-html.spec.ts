import { buildSepaMandateDocument, sepaMandateText } from '@storageos/shared';

import { parseStoredDocument, renderMandateHtml } from '../sepa-mandate-html';

describe('mandato SEPA firmado (PDF)', () => {
  const doc = buildSepaMandateDocument({
    reference: 'MND-1',
    creditor: {
      name: 'Trasteros & Co',
      creditorId: 'ES97ZZZB12345678',
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

  it('el anexo del acreedor lleva el IBAN completo y a quién se envió el enlace', () => {
    const html = renderMandateHtml(doc, {
      signerName: 'Ana',
      method: 'typed',
      signatureImage: null,
      typedSignature: 'Ana',
      signedAt: new Date('2027-01-01T10:00:00Z'),
      ip: null,
      userAgent: null,
      documentHash: 'abc',
      annex: { iban: 'ES9121000418450200051332', signingLinkSentTo: 'ana@example.com' },
    });
    expect(html).toContain('ES91 2100 0418 4502 0005 1332');
    expect(html).toContain('Enlace de firma enviado a: ana@example.com');
    // Sin anexo (no se pasa) el IBAN no aparece.
    const plain = renderMandateHtml(doc, {
      signerName: 'Ana',
      method: 'typed',
      signatureImage: null,
      typedSignature: 'Ana',
      signedAt: new Date('2027-01-01T10:00:00Z'),
      ip: null,
      userAgent: null,
      documentHash: 'abc',
    });
    expect(plain).not.toContain('0005 1332');
  });
});
