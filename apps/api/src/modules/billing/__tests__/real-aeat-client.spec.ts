/**
 * Tests unitarios de `RealAeatClient`. Usan `nock` para interceptar la
 * llamada HTTPS antes del handshake mTLS, por lo que NO comprueban que
 * el mTLS funcione realmente contra AEAT (eso solo se verifica con cert
 * FNMT real). Si verifican el parseo de respuestas SOAP y el manejo de
 * errores.
 */

import { ConfigService } from '@nestjs/config';
import nock from 'nock';
import * as forge from 'node-forge';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { RealAeatClient } from '../aeat-client/real-aeat.client';
import { VerifactuXmlBuilder } from '../aeat-client/verifactu-xml-builder';
import { TenantAeatCredentialsService } from '../tenant-aeat-credentials.service';

import type { Env } from '../../../config/env.schema';

/**
 * Genera un PKCS#12 dummy con node-forge. No es un certificado emitido por
 * la FNMT: solo necesitamos un .p12 con clave + cert valido sintacticamente
 * para que `extractPem` no falle.
 */
function buildTestPkcs12(opts: { notAfter?: Date; password?: string } = {}): {
  p12Buffer: Buffer;
  password: string;
  notAfter: Date;
} {
  const password = opts.password ?? 'password123';
  const notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = notAfter;
  cert.setSubject([
    { name: 'commonName', value: 'TEST CERT' },
    { name: 'serialNumber', value: 'IDCES-12345678Z' },
  ]);
  cert.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { p12Buffer, password, notAfter };
}

const AEAT_HOST = 'https://prewww1.aeat.es';
const AEAT_PATH = '/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1';

function createConfig(
  overrides: Partial<Record<keyof Env, unknown>> = {},
): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    AEAT_MODE: 'sandbox',
    AEAT_SANDBOX_ENDPOINT:
      'https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1',
    AEAT_PRODUCTION_ENDPOINT:
      'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1',
    AEAT_TIMEOUT_MS: 30_000,
    ...overrides,
  };
  return {
    get: (key: string) => {
      if (key in values) return values[key];
      throw new Error(`Unexpected config key in test: ${key}`);
    },
  } as unknown as ConfigService<Env, true>;
}

/** Fixtures de invoice + tenant + customer que devolverían las consultas. */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const INVOICE_2_ID = '44444444-4444-4444-4444-444444444444';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';

function fakeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    ownerId: null,
    invoiceNumber: 'F-2026-0001',
    invoiceType: 'F1' as const,
    issueDate: new Date('2026-05-20T00:00:00.000Z'),
    subtotal: 100 as unknown as number,
    taxAmount: 21 as unknown as number,
    total: 121 as unknown as number,
    hash: 'A'.repeat(64),
    previousHash: null,
    aeatRecordTimestamp: '2026-05-20T10:00:00+02:00',
    previousInvoiceId: null,
    rectifiesInvoiceId: null,
    correctionMethod: null,
    notes: 'Alquiler trastero T-12 mes mayo 2026',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-05-31T00:00:00.000Z'),
    items: [{ taxRate: 21, taxAmount: 21, total: 121, taxCategory: 'S1' }],
    customer: {
      customerType: 'individual',
      companyName: null,
      firstName: 'Juan',
      lastName: 'Perez',
      documentNumber: '12345678Z',
      documentType: 'dni',
      country: 'ES',
    },
    ...overrides,
  };
}

function fakeTenant() {
  return {
    id: TENANT_ID,
    name: 'Trasteros Demo SL',
    billingLegalName: null,
    taxId: 'B12345678',
    verifactuInstallation: '20261108153000-11111111',
    verifactuEnabledAt: new Date('2026-11-08T15:30:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

interface AeatLine {
  number: string;
  date: string;
  ref?: string;
  estado: string;
  code?: string;
  desc?: string;
}

/** Respuesta de la AEAT a un envío (RespuestaSuministro.xsd). */
function aeatResponse(args: {
  estadoEnvio: string;
  lines: AeatLine[];
  csv?: string;
  wait?: string;
}): string {
  const lines = args.lines
    .map(
      (l) => `      <tikR:RespuestaLinea>
        <tikR:IDFactura>
          <tik:IDEmisorFactura>B12345678</tik:IDEmisorFactura>
          <tik:NumSerieFactura>${l.number}</tik:NumSerieFactura>
          <tik:FechaExpedicionFactura>${l.date}</tik:FechaExpedicionFactura>
        </tikR:IDFactura>
        <tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion>${
          l.ref ? `\n        <tikR:RefExterna>${l.ref}</tikR:RefExterna>` : ''
        }
        <tikR:EstadoRegistro>${l.estado}</tikR:EstadoRegistro>${
          l.code ? `\n        <tikR:CodigoErrorRegistro>${l.code}</tikR:CodigoErrorRegistro>` : ''
        }${l.desc ? `\n        <tikR:DescripcionErrorRegistro>${l.desc}</tikR:DescripcionErrorRegistro>` : ''}
      </tikR:RespuestaLinea>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Header/>
  <env:Body Id="Body">
    <tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd" xmlns:tik="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">${
      args.csv ? `\n      <tikR:CSV>${args.csv}</tikR:CSV>` : ''
    }
      <tikR:Cabecera>
        <tik:ObligadoEmision>
          <tik:NombreRazon>Trasteros Demo SL</tik:NombreRazon>
          <tik:NIF>B12345678</tik:NIF>
        </tik:ObligadoEmision>
      </tikR:Cabecera>
      <tikR:TiempoEsperaEnvio>${args.wait ?? '60'}</tikR:TiempoEsperaEnvio>
      <tikR:EstadoEnvio>${args.estadoEnvio}</tikR:EstadoEnvio>
${lines}
    </tikR:RespuestaRegFactuSistemaFacturacion>
  </env:Body>
</env:Envelope>`;
}

const ACCEPTED_ONE = aeatResponse({
  estadoEnvio: 'Correcto',
  csv: 'ABC123XYZ',
  lines: [{ number: 'F-2026-0001', date: '20-05-2026', ref: INVOICE_ID, estado: 'Correcto' }],
});

interface BuildClientArgs {
  decryptedCert?: {
    p12Buffer: Buffer;
    password: string;
    record: {
      certValidTo: Date;
      certNif: string;
      certOrganizationNif: string | null;
      certCommonName: string;
      representativeName: string | null;
    };
  } | null;
  config?: Partial<Record<keyof Env, unknown>>;
  invoices?: ReturnType<typeof fakeInvoice>[];
}

function buildClient(args: BuildClientArgs = {}): {
  client: RealAeatClient;
  credentialsMock: jest.Mocked<Pick<TenantAeatCredentialsService, 'getDecrypted'>>;
  adminMock: {
    invoice: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    tenant: { findUnique: jest.Mock };
    owner: { findUnique: jest.Mock; count: jest.Mock };
  };
} {
  const credentialsMock = {
    getDecrypted: jest.fn().mockResolvedValue(args.decryptedCert ?? null),
  } as unknown as jest.Mocked<Pick<TenantAeatCredentialsService, 'getDecrypted'>>;

  const invoices = args.invoices ?? [fakeInvoice()];
  const adminMock = {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(fakeInvoice()),
      findFirst: jest.fn().mockResolvedValue(null),
      // Las facturas del envío (con `include`) y sus anteriores / rectificadas.
      findMany: jest
        .fn()
        .mockImplementation((q: { include?: unknown }) =>
          Promise.resolve(q.include ? invoices : []),
        ),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue(fakeTenant()),
    },
    owner: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
  };

  const config = createConfig(args.config);
  const xmlBuilder = new VerifactuXmlBuilder();

  const client = new RealAeatClient(
    config,
    credentialsMock as unknown as TenantAeatCredentialsService,
    xmlBuilder,
    adminMock as unknown as PrismaAdminService,
  );
  return { client, credentialsMock, adminMock };
}

const baseBatch = { tenantId: TENANT_ID, ownerId: null, invoiceIds: [INVOICE_ID] };

describe('RealAeatClient', () => {
  let validCert: ReturnType<typeof buildTestPkcs12>;

  beforeAll(() => {
    validCert = buildTestPkcs12();
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  function certArgs() {
    return {
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: {
          certValidTo: validCert.notAfter,
          certNif: 'B12345678',
          certOrganizationNif: null,
          certCommonName: 'TEST CERT',
          representativeName: null,
        },
      },
    };
  }

  it('sin credencial AEAT -> no sale: tenant_no_aeat_credential en cada factura', async () => {
    const { client } = buildClient({ decryptedCert: null });
    const res = await client.sendBatch(baseBatch);
    expect(res.outcome).toBe('not_sent');
    expect(res.message).toBe('tenant_no_aeat_credential');
    expect(res.recordCount).toBe(0);
    expect(res.results[INVOICE_ID]).toEqual({
      status: 'error',
      message: 'tenant_no_aeat_credential',
    });
  });

  it('cert expirado -> no sale: certificate_expired', async () => {
    const expired = buildTestPkcs12({
      notAfter: new Date(Date.now() + 1_000), // valid p12 (forge exige not_after > not_before)
    });
    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: expired.p12Buffer,
        password: expired.password,
        record: {
          certValidTo: new Date(Date.now() - 24 * 3600 * 1000),
          certNif: 'B12345678',
          certOrganizationNif: null,
          certCommonName: 'TEST CERT',
          representativeName: null,
        },
      },
    });
    const res = await client.sendBatch(baseBatch);
    expect(res.outcome).toBe('not_sent');
    expect(res.message).toBe('certificate_expired');
    expect(res.results[INVOICE_ID]?.status).toBe('error');
  });

  it('respuesta Correcto -> registrada con el CSV del envío y la espera que pide la AEAT', async () => {
    nock(AEAT_HOST)
      .post(AEAT_PATH)
      .reply(200, ACCEPTED_ONE, { 'content-type': 'text/xml; charset=utf-8' });

    const { client } = buildClient(certArgs());
    const res = await client.sendBatch(baseBatch);
    expect(res.outcome).toBe('sent');
    expect(res.status).toBe('accepted');
    expect(res.csv).toBe('ABC123XYZ');
    expect(res.waitSeconds).toBe(60);
    expect(res.recordCount).toBe(1);
    expect(res.emitterTaxId).toBe('B12345678');
    expect(res.results[INVOICE_ID]).toMatchObject({ status: 'accepted', csv: 'ABC123XYZ' });
  });

  it('cada registro lleva al fabricante y el número de instalación del emisor', async () => {
    const sent: string[] = [];
    nock(AEAT_HOST)
      .post(AEAT_PATH, (body: string) => {
        sent.push(body);
        return true;
      })
      .times(2)
      .reply(200, ACCEPTED_ONE, { 'content-type': 'text/xml; charset=utf-8' });

    const { client, adminMock } = buildClient(certArgs());
    await client.sendBatch(baseBatch);
    expect(sent[0]).toContain('<sum1:NombreRazon>Urbanbox Soluciones SL</sum1:NombreRazon>');
    expect(sent[0]).toContain('<sum1:NIF>B05691886</sum1:NIF>');
    expect(sent[0]).toContain('<sum1:Version>1.0</sum1:Version>');
    expect(sent[0]).toContain(
      '<sum1:NumeroInstalacion>20261108153000-11111111</sum1:NumeroInstalacion>',
    );
    // Una sola facturación en el negocio.
    expect(sent[0]).toContain('<sum1:IndicadorMultiplesOT>N</sum1:IndicadorMultiplesOT>');
    // El id de la factura vuelve en la línea de la respuesta.
    expect(sent[0]).toContain(`<sum1:RefExterna>${INVOICE_ID}</sum1:RefExterna>`);

    // Un propietario: su propio número, su NIF de obligado y el negocio lleva varias.
    adminMock.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      tenantId: TENANT_ID,
      legalName: 'Propietaria SL',
      taxId: 'B12345674',
    });
    adminMock.owner.count.mockResolvedValue(1);
    adminMock.invoice.findMany.mockImplementation((q: { include?: unknown }) =>
      Promise.resolve(q.include ? [fakeInvoice({ ownerId: OWNER_ID })] : []),
    );
    adminMock.invoice.findMany.mockClear();
    const owned = await client.sendBatch({ ...baseBatch, ownerId: OWNER_ID });
    expect(owned.emitterTaxId).toBe('B12345674');
    expect(sent[1]).toContain(
      '<sum1:NumeroInstalacion>20261108153000-11111111-33333333</sum1:NumeroInstalacion>',
    );
    expect(sent[1]).toContain('<sum1:IndicadorMultiplesOT>S</sum1:IndicadorMultiplesOT>');
    expect(sent[1]).toContain('<sum1:NIF>B12345674</sum1:NIF>');
    // Solo se piden las facturas de ese emisor.
    expect(adminMock.invoice.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: TENANT_ID,
      ownerId: OWNER_ID,
    });
  });

  it('varias facturas van en un mismo envío y cada una recibe su resultado', async () => {
    const sent: string[] = [];
    nock(AEAT_HOST)
      .post(AEAT_PATH, (body: string) => {
        sent.push(body);
        return true;
      })
      .reply(
        200,
        aeatResponse({
          estadoEnvio: 'ParcialmenteCorrecto',
          csv: 'CSV-LOTE',
          wait: '120',
          lines: [
            { number: 'F-2026-0001', date: '20-05-2026', ref: INVOICE_ID, estado: 'Correcto' },
            {
              number: 'F-2026-0002',
              date: '21-05-2026',
              ref: INVOICE_2_ID,
              estado: 'Incorrecto',
              code: '1105',
              desc: 'El NIF del destinatario no está identificado',
            },
          ],
        }),
      );

    const { client } = buildClient({
      ...certArgs(),
      invoices: [
        fakeInvoice(),
        fakeInvoice({
          id: INVOICE_2_ID,
          invoiceNumber: 'F-2026-0002',
          issueDate: new Date('2026-05-21T00:00:00.000Z'),
          previousInvoiceId: INVOICE_ID,
          previousHash: 'A'.repeat(64),
          hash: 'B'.repeat(64),
        }),
      ],
    });
    const res = await client.sendBatch({ ...baseBatch, invoiceIds: [INVOICE_ID, INVOICE_2_ID] });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.match(/<sum1:RegistroAlta>/g)).toHaveLength(2);
    // En el orden de la cadena: la primera antes que la segunda.
    expect(sent[0]!.indexOf('F-2026-0001')).toBeLessThan(sent[0]!.indexOf('F-2026-0002'));
    expect(res.outcome).toBe('sent');
    expect(res.status).toBe('partially_accepted');
    expect(res.recordCount).toBe(2);
    expect(res.waitSeconds).toBe(120);
    expect(res.results[INVOICE_ID]).toMatchObject({ status: 'accepted', csv: 'CSV-LOTE' });
    expect(res.results[INVOICE_2_ID]).toMatchObject({
      status: 'rejected',
      message: '[1105] El NIF del destinatario no está identificado',
    });
  });

  it('respuesta AceptadoConErrores -> accepted_with_warnings + CSV', async () => {
    nock(AEAT_HOST)
      .post(AEAT_PATH)
      .reply(
        200,
        aeatResponse({
          estadoEnvio: 'ParcialmenteCorrecto',
          csv: 'WARN-CSV-001',
          lines: [
            {
              number: 'F-2026-0001',
              date: '20-05-2026',
              ref: INVOICE_ID,
              estado: 'AceptadoConErrores',
              code: '2004',
              desc: 'FechaHoraHusoGenRegistro fuera de margen',
            },
          ],
        }),
      );

    const { client } = buildClient(certArgs());
    const res = await client.sendBatch(baseBatch);
    expect(res.results[INVOICE_ID]).toMatchObject({
      status: 'accepted_with_warnings',
      csv: 'WARN-CSV-001',
    });
  });

  it('HTTP 500 -> falló: hay que repetir el envío', async () => {
    nock(AEAT_HOST).post(AEAT_PATH).reply(500, '<html>Internal Server Error</html>');

    const { client } = buildClient(certArgs());
    const res = await client.sendBatch(baseBatch);
    expect(res.outcome).toBe('failed');
    expect(res.message).toBe('aeat_server_error');
    expect(res.results[INVOICE_ID]?.status).toBe('error');
  });

  describe('getStatus', () => {
    it('respuesta Correcto -> accepted con csv', async () => {
      nock(AEAT_HOST)
        .post(AEAT_PATH)
        .reply(
          200,
          `<?xml version="1.0"?>
<Envelope>
  <Body>
    <EstadoRegistro>Correcto</EstadoRegistro>
    <CSV>STATUS-CSV-001</CSV>
  </Body>
</Envelope>`,
        );

      const { client } = buildClient({
        decryptedCert: {
          p12Buffer: validCert.p12Buffer,
          password: validCert.password,
          record: {
            certValidTo: validCert.notAfter,
            certNif: 'B12345678',
            certOrganizationNif: null,
            certCommonName: 'TEST CERT',
            representativeName: null,
          },
        },
      });
      const res = await client.getStatus({ invoiceId: INVOICE_ID });
      expect(res.status).toBe('accepted');
      expect(res.csv).toBe('STATUS-CSV-001');
    });

    it('respuesta NoRegistrado -> pending', async () => {
      nock(AEAT_HOST)
        .post(AEAT_PATH)
        .reply(
          200,
          `<?xml version="1.0"?>
<Envelope>
  <Body>
    <EstadoRegistro>NoRegistrado</EstadoRegistro>
  </Body>
</Envelope>`,
        );

      const { client } = buildClient({
        decryptedCert: {
          p12Buffer: validCert.p12Buffer,
          password: validCert.password,
          record: {
            certValidTo: validCert.notAfter,
            certNif: 'B12345678',
            certOrganizationNif: null,
            certCommonName: 'TEST CERT',
            representativeName: null,
          },
        },
      });
      const res = await client.getStatus({ invoiceId: INVOICE_ID });
      expect(res.status).toBe('pending');
      expect(res.message).toBe('aeat_not_registered_yet');
    });

    it('tenant sin credencial -> error tenant_no_aeat_credential', async () => {
      const { client } = buildClient({ decryptedCert: null });
      const res = await client.getStatus({ invoiceId: INVOICE_ID });
      expect(res.status).toBe('error');
      expect(res.message).toBe('tenant_no_aeat_credential');
    });
  });

  // Nota: nock no dispara correctamente el `req.setTimeout` del socket, por
  // lo que en lugar de simular un retraso real emitimos directamente un
  // `Error('timeout')` que es exactamente lo que `req.destroy(...)` haria al
  // agotarse el timer en condiciones reales.
  it('timeout -> falló con mensaje timeout', async () => {
    nock(AEAT_HOST).post(AEAT_PATH).replyWithError(new Error('timeout'));

    const { client } = buildClient({ ...certArgs(), config: { AEAT_TIMEOUT_MS: 50 } });
    const res = await client.sendBatch(baseBatch);
    expect(res.outcome).toBe('failed');
    expect(res.message).toMatch(/timeout/i);
    expect(res.recordCount).toBe(1);
    expect(res.results[INVOICE_ID]?.status).toBe('error');
  });
});
