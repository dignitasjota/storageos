import { buildPain008 } from '../sepa-pain008';

describe('buildPain008 (AEB 19-14)', () => {
  const xml = buildPain008({
    messageId: 'REM-ABC',
    creationDateTime: new Date('2026-10-23T10:00:00Z'),
    creditor: {
      name: 'Peña & Hijos, S.L.',
      creditorId: 'ES11000B12345674',
      iban: 'ES9121000418450200051332',
    },
    collectionDate: '2026-11-02',
    transactions: [
      {
        endToEndId: 'E2E-F-2026-1',
        amountCents: 12100,
        mandateReference: 'MND//Ñ1',
        mandateSignedDate: '2026-01-15',
        sequenceType: 'FRST',
        debtorName: `José María Núñez ${'x'.repeat(80)}`,
        debtorIban: 'ES6621000418401234567891',
        remittanceInfo: `Factura F-2026-1 · trastero «A1» ${'y'.repeat(200)}`,
      },
    ],
  });

  it('identifica al presentador con el identificador del acreedor', () => {
    expect(xml).toContain(
      '<InitgPty><Nm>Pena + Hijos, S.L.</Nm><Id><OrgId><Othr><Id>ES11000B12345674</Id></Othr></OrgId></Id></InitgPty>',
    );
  });

  it('textos en caracteres SEPA y con su longitud máxima', () => {
    const debtor = /<Dbtr><Nm>([^<]*)<\/Nm>/.exec(xml)?.[1] ?? '';
    expect(debtor.startsWith('Jose Maria Nunez')).toBe(true);
    expect(debtor.length).toBeLessThanOrEqual(70);
    const ustrd = /<Ustrd>([^<]*)<\/Ustrd>/.exec(xml)?.[1] ?? '';
    expect(ustrd.length).toBeLessThanOrEqual(140);
    expect(ustrd).not.toMatch(/[«»·]/);
    expect(xml).toContain('<MndtId>MND/N1</MndtId>');
  });
});
