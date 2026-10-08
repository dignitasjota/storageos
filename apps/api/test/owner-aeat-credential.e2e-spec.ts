import { PrismaClient } from '@storageos/database';
import * as forge from 'node-forge';
import request from 'supertest';

import { AeatCertExpiryService } from '../src/modules/admin/aeat-cert-expiry.service';
import { TenantAeatCredentialsService } from '../src/modules/billing/tenant-aeat-credentials.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
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

/** Plan Administrador: certificado propio de un propietario para Veri*Factu. */
describe('Certificado de un propietario (e2e)', () => {
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

  it('se sube aparte del del tenant y no lo sustituye', async () => {
    const user = await registerVerifiedUser(app, 'ownercert');
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const http = () => request(app.getHttpServer());
    await admin.tenant.update({ where: { id: user.tenantId }, data: { taxId: 'B87654321' } });
    await setTenantFeatureOverride(user.slug, 'multi_owner', true);
    const owner = await http()
      .post('/owners')
      .set(auth)
      .send({ legalName: 'Inversiones Pérez SL', taxId: 'B12345674' })
      .expect(201);

    const send = (url: string, p12: Buffer) =>
      http()
        .post(url)
        .set(auth)
        .field('password', 'password123')
        .field('environment', 'sandbox')
        .attach('file', p12, { filename: 'cert.p12', contentType: 'application/x-pkcs12' });

    // El certificado del administrador (el tenant).
    await send(
      '/billing/aeat-credentials',
      buildPkcs12([
        { name: 'serialNumber', value: 'VATES-B87654321' },
        { name: 'commonName', value: 'ADMINISTRACIONES SL' },
      ]),
    ).expect(201);

    // El del propietario: es suyo, así que no va como representante.
    const ownCert = await send(
      `/owners/${owner.body.id}/aeat-credential`,
      buildPkcs12([
        { name: 'serialNumber', value: 'VATES-B12345674' },
        { name: 'commonName', value: 'INVERSIONES PEREZ SL' },
      ]),
    );
    expect(ownCert.status).toBe(201);
    expect(ownCert.body.certNif).toBe('B12345674');
    expect(ownCert.body.representative).toBeNull();

    const tenantCert = await http().get('/billing/aeat-credentials/me').set(auth).expect(200);
    expect(tenantCert.body.certNif).toBe('B87654321');
    const got = await http().get(`/owners/${owner.body.id}/aeat-credential`).set(auth).expect(200);
    expect(got.body.credential.certNif).toBe('B12345674');

    // Si el del propietario caduca, se envía con el del administrador (como
    // representante) en vez de fallar en la AEAT.
    const certs = app.get(TenantAeatCredentialsService);
    expect((await certs.getDecrypted(user.tenantId, owner.body.id))?.record.certNif).toBe(
      'B12345674',
    );
    await admin.tenantAeatCredential.updateMany({
      where: { tenantId: user.tenantId, ownerId: owner.body.id },
      data: { certValidTo: new Date(Date.now() - 24 * 3600 * 1000) },
    });
    expect((await certs.getDecrypted(user.tenantId, owner.body.id))?.record.certNif).toBe(
      'B87654321',
    );
    // El aviso de caducidad dice de quién es y lleva a Propietarios.
    await app.get(AeatCertExpiryService).run();
    const notice = await admin.notification.findFirst({
      where: { tenantId: user.tenantId, type: 'aeat.certificate_expiring' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notice?.title).toContain('Inversiones Pérez SL');
    expect(notice?.link).toBe('/owners');

    await http().delete(`/owners/${owner.body.id}/aeat-credential`).set(auth).expect(204);
    const after = await http()
      .get(`/owners/${owner.body.id}/aeat-credential`)
      .set(auth)
      .expect(200);
    expect(after.body.credential).toBeNull();
    await http().get('/billing/aeat-credentials/me').set(auth).expect(200);
  });
});
