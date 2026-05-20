import * as forge from 'node-forge';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface BuildCertOptions {
  commonName?: string;
  nifInSerialNumber?: string;
  notBefore?: Date;
  notAfter?: Date;
  password?: string;
}

interface BuiltCert {
  p12Buffer: Buffer;
  password: string;
}

/**
 * Genera on-the-fly un PKCS#12 dummy. El test no llega a hacer mTLS contra
 * la AEAT; solo necesitamos un .p12 valido sintacticamente con un subject
 * que contenga el NIF en `serialNumber` (estilo FNMT IDCES-XXXXXXXXX).
 */
function buildTestPkcs12(opts: BuildCertOptions = {}): BuiltCert {
  const password = opts.password ?? 'password123';
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);

  const subjectAttrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: opts.commonName ?? 'TEST CERT' },
  ];
  if (opts.nifInSerialNumber !== null) {
    subjectAttrs.push({
      name: 'serialNumber',
      value: `IDCES-${opts.nifInSerialNumber ?? '12345678Z'}`,
    });
  }
  cert.setSubject(subjectAttrs);
  cert.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { p12Buffer, password };
}

describe('Tenant AEAT credentials (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('upload OK con cert valido -> 201 + metadata sin secretos', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-upload');
    const { p12Buffer, password } = buildTestPkcs12({
      commonName: 'TEST CERT',
      nifInSerialNumber: '12345678Z',
    });

    const res = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', password)
      .field('environment', 'sandbox')
      .attach('file', p12Buffer, { filename: 'cert.p12', contentType: 'application/x-pkcs12' });

    expect(res.status).toBe(201);
    expect(res.body.certCommonName).toBe('TEST CERT');
    expect(res.body.certNif).toBe('12345678Z');
    expect(res.body.certIssuer).toBe('Test CA');
    expect(res.body.environment).toBe('sandbox');
    expect(res.body.tenantId).toBe(owner.tenantId);
    expect(new Date(res.body.certValidTo).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.certP12Encrypted).toBeUndefined();
    expect(res.body.certPasswordEncrypted).toBeUndefined();
  });

  it('upload con password incorrecto -> 400 invalid_certificate_password', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-badpw');
    const { p12Buffer } = buildTestPkcs12({ nifInSerialNumber: '12345678Z' });

    const res = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', 'wrong-password')
      .attach('file', p12Buffer, { filename: 'cert.p12' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_certificate_password');
  });

  it('upload con cert expirado -> 400 certificate_expired', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-expired');
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const beforeYesterday = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const { p12Buffer, password } = buildTestPkcs12({
      nifInSerialNumber: '12345678Z',
      notBefore: beforeYesterday,
      notAfter: yesterday,
    });

    const res = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', password)
      .attach('file', p12Buffer, { filename: 'cert.p12' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('certificate_expired');
  });

  it('upload sin NIF en subject -> 400 certificate_missing_nif', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-no-nif');
    const { p12Buffer, password } = buildTestPkcs12({
      commonName: 'Sin Identificador',
      nifInSerialNumber: null as unknown as string, // fuerza omitir el serialNumber
    });

    const res = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', password)
      .attach('file', p12Buffer, { filename: 'cert.p12' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('certificate_missing_nif');
  });

  it('GET /me sin upload previo -> 404', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-empty');
    const res = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('aeat_credential_not_found');
  });

  it('GET /me tras upload -> 200 sin exponer secretos', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-get');
    const { p12Buffer, password } = buildTestPkcs12({ nifInSerialNumber: '87654321X' });
    const up = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', password)
      .attach('file', p12Buffer, { filename: 'cert.p12' });
    expect(up.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.certNif).toBe('87654321X');
    expect(res.body.certP12Encrypted).toBeUndefined();
    expect(res.body.certPasswordEncrypted).toBeUndefined();
    expect(res.body.revokedAt).toBeNull();
  });

  it('DELETE /me revoca y vuelve a devolver 404 en GET', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-revoke');
    const { p12Buffer, password } = buildTestPkcs12({ nifInSerialNumber: '12345678Z' });
    await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', password)
      .attach('file', p12Buffer, { filename: 'cert.p12' })
      .expect(201);

    const del = await request(app.getHttpServer())
      .delete('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'rotacion manual' });
    expect(del.status).toBe(204);

    const get = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(get.status).toBe(404);
  });

  it('re-upload tras revoke crea credencial activa (201) y GET /me la devuelve', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-reupload');
    const first = buildTestPkcs12({ nifInSerialNumber: '11111111A' });
    await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', first.password)
      .attach('file', first.p12Buffer, { filename: 'cert1.p12' })
      .expect(201);

    await request(app.getHttpServer())
      .delete('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'caducidad proxima' })
      .expect(204);

    const second = buildTestPkcs12({ nifInSerialNumber: '22222222B' });
    const reup = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('password', second.password)
      .attach('file', second.p12Buffer, { filename: 'cert2.p12' });
    expect(reup.status).toBe(201);
    expect(reup.body.certNif).toBe('22222222B');
    expect(reup.body.revokedAt).toBeNull();

    const get = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(get.status).toBe(200);
    expect(get.body.certNif).toBe('22222222B');
  });

  it('upload con rol staff -> 403', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-rbac');
    const staffEmail = `staff-aeat-${Date.now()}@e2e.local`;
    await deleteAllMessages();

    // Owner invita staff.
    await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: staffEmail, role: 'staff' })
      .expect(201);

    const mail = await waitForEmail(staffEmail, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');

    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Staff AEAT', password: 'Secret123' });
    expect(accept.status).toBe(200);
    const staffToken = accept.body.accessToken as string;

    const { p12Buffer, password } = buildTestPkcs12({ nifInSerialNumber: '12345678Z' });
    const res = await request(app.getHttpServer())
      .post('/billing/aeat-credentials')
      .set('Authorization', `Bearer ${staffToken}`)
      .field('password', password)
      .attach('file', p12Buffer, { filename: 'cert.p12' });

    expect(res.status).toBe(403);
  });
});
