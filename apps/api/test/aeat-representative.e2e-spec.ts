import { PrismaClient } from '@storageos/database';
import * as forge from 'node-forge';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** PKCS#12 de prueba con el subject indicado. */
function buildPkcs12(subject: forge.pki.CertificateField[]): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject(subject);
  cert.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'password123', {
    algorithm: '3des',
  });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/**
 * Certificado de un administrador o gestoría apoderada: los envíos a
 * Veri*Factu van con <Representante>.
 */
describe('Veri*Factu con certificado de representante (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('detecta el representante, deja cambiar su nombre y lo quita con un certificado propio', async () => {
    const owner = await registerVerifiedUser(app, 'aeatrep');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await admin.tenant.update({ where: { id: owner.tenantId }, data: { taxId: 'B12345674' } });

    const upload = (p12: Buffer) =>
      request(app.getHttpServer())
        .post('/billing/aeat-credentials')
        .set(auth)
        .field('password', 'password123')
        .field('environment', 'sandbox')
        .attach('file', p12, { filename: 'cert.p12', contentType: 'application/x-pkcs12' });

    // Certificado de representante de una gestoría (otra empresa).
    const res = await upload(
      buildPkcs12([
        { name: 'serialNumber', value: 'IDCES-12345678Z' },
        { type: '2.5.4.97', value: 'VATES-B87654321' } as forge.pki.CertificateField,
        { name: 'organizationName', value: 'GESTORIA EJEMPLO SL' },
        { name: 'commonName', value: '12345678Z JUAN PEREZ (R: B87654321)' },
      ]),
    );
    expect(res.status).toBe(201);
    expect(res.body.certOrganizationNif).toBe('B87654321');
    expect(res.body.representative).toEqual({
      taxId: 'B87654321',
      name: 'GESTORIA EJEMPLO SL',
    });

    const renamed = await request(app.getHttpServer())
      .patch('/billing/aeat-credentials/me/representative')
      .set(auth)
      .send({ name: 'Gestoría Ejemplo, S.L.' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.representative.name).toBe('Gestoría Ejemplo, S.L.');

    const me = await request(app.getHttpServer()).get('/billing/aeat-credentials/me').set(auth);
    expect(me.body.representative).toEqual({
      taxId: 'B87654321',
      name: 'Gestoría Ejemplo, S.L.',
    });

    // Certificado de la propia empresa: ya no hay representante.
    const own = await upload(
      buildPkcs12([
        { name: 'serialNumber', value: 'IDCES-B12345674' },
        { name: 'commonName', value: 'TRASTEROS SL' },
      ]),
    );
    expect(own.status).toBe(201);
    expect(own.body.representative).toBeNull();

    await request(app.getHttpServer())
      .patch('/billing/aeat-credentials/me/representative')
      .set(auth)
      .send({ name: 'x'.repeat(200) })
      .expect(400);
  });
});
