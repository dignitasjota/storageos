import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import {
  VerifactuXmlBuilder,
  type BuildRegistroAltaArgs,
} from '../aeat-client/verifactu-xml-builder';

/**
 * Valida el XML que se envía a la AEAT contra sus esquemas oficiales (copias en
 * `fixtures/aeat-xsd`) con `xmllint`. Las demás pruebas miran el contenido; esta
 * mira el orden y los espacios de nombres, que la AEAT exige al pie de la letra
 * (un registro fuera de esquema se rechaza entero).
 *
 * En la CI `xmllint` es obligatorio (lo instala el workflow); en local, si no
 * está instalado, se salta.
 */
const XSD_DIR = path.join(__dirname, 'fixtures', 'aeat-xsd');

function hasXmllint(): boolean {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeXsd = hasXmllint() || process.env.CI ? describe : describe.skip;

/** El cuerpo del sobre SOAP como documento propio, con sus espacios de nombres. */
function bodyDocument(soap: string): string {
  const envelopeAttrs = soap.match(/<soapenv:Envelope([^>]*)>/)?.[1] ?? '';
  const namespaces = envelopeAttrs.replace(/\s*xmlns:soapenv="[^"]*"/, '').trim();
  const body = soap.match(/<soapenv:Body>\s*([\s\S]*?)\s*<\/soapenv:Body>/)?.[1] ?? '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body.replace(/^<([\w:]+)/, `<$1 ${namespaces}`)}`;
}

/** `ok` o el error de `xmllint`. */
function validate(doc: string, xsd: string): string {
  try {
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', path.join(XSD_DIR, xsd), '-'], {
      input: doc,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'ok';
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr;
    return stderr ? stderr.toString() : String(err);
  }
}

function baseArgs(): BuildRegistroAltaArgs {
  return {
    tenant: { name: 'Trasteros Demo SL', taxId: 'B12345674' },
    system: { installationNumber: '20261108153000-01a1bb39', multipleTaxpayers: false },
    invoice: {
      series: 'FA',
      invoiceNumber: 'FA/2026/00007',
      issueDate: new Date('2026-11-07T00:00:00.000Z'),
      description: 'Alquiler trastero A-12 noviembre 2026',
      invoiceType: 'F1',
      breakdown: [{ taxRate: 21, base: 100, cuota: 21, category: 'S1' }],
      taxAmount: 21,
      total: 121,
      recordTimestamp: '2026-11-07T10:00:00+01:00',
      hash: 'A'.repeat(64),
      previousHash: null,
    },
    recipient: { name: 'Ana García López', taxId: '12345678Z' },
  };
}

const ORIGINAL = {
  emitterTaxId: 'B12345674',
  invoiceNumber: 'FA/2026/00001',
  issueDate: new Date('2026-05-10T00:00:00.000Z'),
};

const CASES: Array<[string, () => BuildRegistroAltaArgs]> = [
  ['F1, primer registro', baseArgs],
  [
    'F1 encadenada, con líneas no sujeta y exenta, enviada por un representante',
    () => {
      const a = baseArgs();
      a.invoice.previousHash = 'B'.repeat(64);
      a.invoice.previousInvoiceNumber = 'FA/2026/00006';
      a.invoice.previousInvoiceDate = new Date('2026-11-01T00:00:00.000Z');
      a.invoice.previousEmitterNif = 'B12345674';
      a.invoice.breakdown = [
        { taxRate: 21, base: 100, cuota: 21, category: 'S1' },
        { taxRate: 0, base: 50, cuota: 0, category: 'N1' },
        { taxRate: 0, base: 30, cuota: 0, category: 'E1' },
      ];
      a.invoice.total = 201;
      a.representative = { name: 'Gestoría SL', taxId: 'B87654321' };
      a.system.multipleTaxpayers = true;
      return a;
    },
  ],
  [
    'F2 sin destinatario',
    () => {
      const a = baseArgs();
      a.invoice.invoiceType = 'F2';
      delete a.recipient;
      return a;
    },
  ],
  [
    'F1 a un cliente extranjero (IDOtro)',
    () => {
      const a = baseArgs();
      a.recipient = {
        name: 'John Smith',
        otherId: { country: 'GB', idType: '03', id: 'X1234567' },
      };
      return a;
    },
  ],
  [
    'R1 por diferencias',
    () => {
      const a = baseArgs();
      a.invoice.invoiceType = 'R1';
      a.invoice.correctionMethod = 'I';
      a.invoice.rectifies = [ORIGINAL];
      a.invoice.breakdown = [{ taxRate: 21, base: -50, cuota: -10.5, category: 'S1' }];
      a.invoice.taxAmount = -10.5;
      a.invoice.total = -60.5;
      return a;
    },
  ],
  [
    'R4 por sustitución',
    () => {
      const a = baseArgs();
      a.invoice.invoiceType = 'R4';
      a.invoice.correctionMethod = 'S';
      a.invoice.rectifies = [ORIGINAL];
      a.invoice.originalAmounts = { baseRectificada: 100, cuotaRectificada: 21 };
      return a;
    },
  ],
  [
    'R5 de una simplificada',
    () => {
      const a = baseArgs();
      a.invoice.invoiceType = 'R5';
      a.invoice.correctionMethod = 'I';
      a.invoice.rectifies = [{ ...ORIGINAL, invoiceNumber: 'FS/2026/00003' }];
      delete a.recipient;
      return a;
    },
  ],
];

describeXsd('XML de Veri*Factu contra los esquemas de la AEAT', () => {
  const builder = new VerifactuXmlBuilder();

  it.each(CASES)('registro de alta: %s', (_name, build) => {
    const doc = bodyDocument(builder.buildRegistroAlta(build()));
    expect(validate(doc, 'SuministroLR.xsd')).toBe('ok');
  });

  it('un envío con varios registros del mismo emisor, cada uno con su RefExterna', () => {
    const records = CASES.map(([, build], i) => {
      const a = build();
      a.invoice.refExterna = `0000000${i}-2222-4222-8222-222222222222`;
      a.invoice.invoiceNumber = `FA/2026/0001${i}`;
      return builder.buildRegistroAltaRecord(a);
    });
    const doc = bodyDocument(
      builder.buildSubmission({
        issuer: baseArgs().tenant,
        representative: { name: 'Gestoría SL', taxId: 'B87654321' },
        records,
      }),
    );
    expect(doc.match(/<sum1:RegistroAlta>/g)).toHaveLength(CASES.length);
    expect(validate(doc, 'SuministroLR.xsd')).toBe('ok');
  });

  it('un nombre más largo que lo que admite la AEAT se recorta (no tumba el envío)', () => {
    const a = baseArgs();
    a.tenant.name = 'Trasteros '.repeat(20);
    a.recipient = { name: 'Cliente '.repeat(30), taxId: '12345678Z' };
    const doc = bodyDocument(builder.buildRegistroAlta(a));
    expect(validate(doc, 'SuministroLR.xsd')).toBe('ok');
  });

  it.each([
    ['del propio emisor', false],
    ['como representante', true],
  ])('consulta de estado %s', (_name, asRepresentative) => {
    const doc = bodyDocument(
      builder.buildConsultaFactu({
        emitterName: 'Trasteros Demo SL',
        emitterTaxId: 'B12345674',
        invoiceNumber: 'FA/2026/00007',
        issueDate: new Date('2026-11-07T00:00:00.000Z'),
        asRepresentative,
      }),
    );
    expect(validate(doc, 'ConsultaLR.xsd')).toBe('ok');
  });
});
