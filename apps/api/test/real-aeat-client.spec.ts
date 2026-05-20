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

import { RealAeatClient } from '../src/modules/billing/aeat-client/real-aeat.client';
import { VerifactuXmlBuilder } from '../src/modules/billing/aeat-client/verifactu-xml-builder';
import { TenantAeatCredentialsService } from '../src/modules/billing/tenant-aeat-credentials.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import type { Env } from '../src/config/env.schema';

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
    AEAT_SISTEMA_NIF: 'B00000000',
    AEAT_SISTEMA_NOMBRE: 'StorageOS',
    AEAT_SISTEMA_VERSION: '1.0.0',
    AEAT_SISTEMA_INSTALACION: '001',
    ...overrides,
  };
  return {
    get: (key: string) => {
      if (key in values) return values[key];
      throw new Error(`Unexpected config key in test: ${key}`);
    },
  } as unknown as ConfigService<Env, true>;
}

/** Fixture base de invoice + tenant + customer que `findUnique` devolveria. */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';

function fakeInvoice() {
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    invoiceNumber: 'F-2026-0001',
    issueDate: new Date('2026-05-20T00:00:00.000Z'),
    subtotal: 100 as unknown as number,
    taxAmount: 21 as unknown as number,
    total: 121 as unknown as number,
    hash: 'A'.repeat(64),
    notes: 'Alquiler trastero T-12 mes mayo 2026',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-05-31T00:00:00.000Z'),
    items: [],
    customer: {
      customerType: 'individual',
      companyName: null,
      firstName: 'Juan',
      lastName: 'Perez',
      documentNumber: '12345678Z',
    },
  };
}

function fakeTenant() {
  return {
    id: TENANT_ID,
    name: 'Trasteros Demo SL',
    taxId: 'B12345678',
  };
}

interface BuildClientArgs {
  decryptedCert?: {
    p12Buffer: Buffer;
    password: string;
    record: { certValidTo: Date };
  } | null;
  config?: Partial<Record<keyof Env, unknown>>;
}

function buildClient(args: BuildClientArgs = {}): {
  client: RealAeatClient;
  credentialsMock: jest.Mocked<Pick<TenantAeatCredentialsService, 'getDecrypted'>>;
  adminMock: {
    invoice: { findUnique: jest.Mock; findFirst: jest.Mock };
    tenant: { findUnique: jest.Mock };
  };
} {
  const credentialsMock = {
    getDecrypted: jest.fn().mockResolvedValue(args.decryptedCert ?? null),
  } as unknown as jest.Mocked<Pick<TenantAeatCredentialsService, 'getDecrypted'>>;

  const adminMock = {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(fakeInvoice()),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue(fakeTenant()),
    },
  };

  const config = createConfig(args.config);
  const xmlBuilder = new VerifactuXmlBuilder(config);

  const client = new RealAeatClient(
    config,
    credentialsMock as unknown as TenantAeatCredentialsService,
    xmlBuilder,
    adminMock as unknown as PrismaAdminService,
  );
  return { client, credentialsMock, adminMock };
}

const baseSendArgs = {
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  invoiceNumber: 'F-2026-0001',
  issueDate: new Date('2026-05-20T00:00:00.000Z'),
  total: 121,
  previousHash: null,
  hash: 'A'.repeat(64),
  emitterTaxId: 'B12345678',
};

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

  it('sin credencial AEAT -> error tenant_no_aeat_credential', async () => {
    const { client } = buildClient({ decryptedCert: null });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('error');
    expect(res.message).toBe('tenant_no_aeat_credential');
  });

  it('cert expirado -> error certificate_expired', async () => {
    const expired = buildTestPkcs12({
      notAfter: new Date(Date.now() + 1_000), // valid p12 (forge exige not_after > not_before)
    });
    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: expired.p12Buffer,
        password: expired.password,
        record: { certValidTo: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('error');
    expect(res.message).toBe('certificate_expired');
  });

  it('respuesta Correcto + CSV -> accepted con csv', async () => {
    nock(AEAT_HOST)
      .post(AEAT_PATH)
      .reply(
        200,
        `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <RespuestaRegFactuSistemaFacturacion>
      <RespuestaLinea>
        <EstadoRegistro>Correcto</EstadoRegistro>
        <CSV>ABC123XYZ</CSV>
      </RespuestaLinea>
    </RespuestaRegFactuSistemaFacturacion>
  </soapenv:Body>
</soapenv:Envelope>`,
        { 'content-type': 'text/xml; charset=utf-8' },
      );

    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: { certValidTo: validCert.notAfter },
      },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('accepted');
    expect(res.csv).toBe('ABC123XYZ');
  });

  it('respuesta AceptadoConErrores -> accepted_with_warnings + CSV', async () => {
    nock(AEAT_HOST)
      .post(AEAT_PATH)
      .reply(
        200,
        `<?xml version="1.0"?>
<Envelope>
  <Body>
    <EstadoRegistro>AceptadoConErrores</EstadoRegistro>
    <CSV>WARN-CSV-001</CSV>
  </Body>
</Envelope>`,
      );

    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: { certValidTo: validCert.notAfter },
      },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('accepted_with_warnings');
    expect(res.csv).toBe('WARN-CSV-001');
  });

  it('respuesta Incorrecto -> rejected con mensaje', async () => {
    nock(AEAT_HOST)
      .post(AEAT_PATH)
      .reply(
        200,
        `<?xml version="1.0"?>
<Envelope>
  <Body>
    <EstadoRegistro>Incorrecto</EstadoRegistro>
    <CodigoErrorRegistro>1001</CodigoErrorRegistro>
    <DescripcionErrorRegistro>NIF invalido</DescripcionErrorRegistro>
  </Body>
</Envelope>`,
      );

    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: { certValidTo: validCert.notAfter },
      },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('rejected');
    expect(res.message).toContain('NIF invalido');
    expect(res.raw?.code).toBe('1001');
  });

  it('HTTP 500 -> error aeat_server_error', async () => {
    nock(AEAT_HOST).post(AEAT_PATH).reply(500, '<html>Internal Server Error</html>');

    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: { certValidTo: validCert.notAfter },
      },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('error');
    expect(res.message).toBe('aeat_server_error');
  });

  // Nota: nock no dispara correctamente el `req.setTimeout` del socket, por
  // lo que en lugar de simular un retraso real emitimos directamente un
  // `Error('timeout')` que es exactamente lo que `req.destroy(...)` haria al
  // agotarse el timer en condiciones reales.
  it('timeout -> error con mensaje timeout', async () => {
    nock(AEAT_HOST).post(AEAT_PATH).replyWithError(new Error('timeout'));

    const { client } = buildClient({
      decryptedCert: {
        p12Buffer: validCert.p12Buffer,
        password: validCert.password,
        record: { certValidTo: validCert.notAfter },
      },
      config: { AEAT_TIMEOUT_MS: 50 },
    });
    const res = await client.sendInvoice(baseSendArgs);
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/timeout/i);
  });
});
