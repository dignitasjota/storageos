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
  password?: string;
}

interface BuiltCert {
  p12Buffer: Buffer;
  password: string;
}

/**
 * Genera un PKCS#12 dummy con el NIF embebido en `serialNumber`. Mismo
 * helper que en `tenant-aeat-credentials.e2e-spec.ts`; lo duplicamos
 * aquí para no acoplar suites de tests entre sí.
 */
function buildTestPkcs12(opts: BuildCertOptions = {}): BuiltCert {
  const password = opts.password ?? 'password123';
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);

  cert.setSubject([
    { name: 'commonName', value: opts.commonName ?? 'TEST CERT' },
    { name: 'serialNumber', value: `IDCES-${opts.nifInSerialNumber ?? '12345678Z'}` },
  ]);
  cert.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { p12Buffer, password };
}

interface HistoryEntry {
  id: string;
  certNif: string;
  certCommonName: string;
  environment: 'sandbox' | 'production';
  uploadedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

async function uploadCert(
  app: INestApplication,
  token: string,
  cert: BuiltCert,
  filename = 'cert.p12',
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/billing/aeat-credentials')
    .set('Authorization', `Bearer ${token}`)
    .field('password', cert.password)
    .field('environment', 'sandbox')
    .attach('file', cert.p12Buffer, { filename, contentType: 'application/x-pkcs12' });
}

describe('Tenant AEAT credentials — histórico (Fase 11A.2 e2e)', () => {
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

  it('upload, re-upload y revoke conservan trazabilidad en /history', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-hist-flow');

    // 1. Upload cert A → 201, histórico tiene 1 entry activa.
    const certA = buildTestPkcs12({ commonName: 'CERT A', nifInSerialNumber: '11111111A' });
    const upA = await uploadCert(app, owner.accessToken, certA, 'a.p12');
    expect(upA.status).toBe(201);

    let hist = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(hist.status).toBe(200);
    expect(hist.body).toHaveLength(1);
    const histA1: HistoryEntry[] = hist.body;
    expect(histA1[0].certNif).toBe('11111111A');
    expect(histA1[0].revokedAt).toBeNull();
    expect(histA1[0].revokedReason).toBeNull();

    // 2. Upload cert B → 201, histórico tiene 2: A revocada (replaced),
    //    B activa. La activa es la primera por ordenación uploadedAt desc.
    const certB = buildTestPkcs12({ commonName: 'CERT B', nifInSerialNumber: '22222222B' });
    const upB = await uploadCert(app, owner.accessToken, certB, 'b.p12');
    expect(upB.status).toBe(201);
    expect(upB.body.certNif).toBe('22222222B');

    hist = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(hist.status).toBe(200);
    expect(hist.body).toHaveLength(2);
    const histAB: HistoryEntry[] = hist.body;
    expect(histAB[0].certNif).toBe('22222222B');
    expect(histAB[0].revokedAt).toBeNull();
    expect(histAB[1].certNif).toBe('11111111A');
    expect(histAB[1].revokedAt).not.toBeNull();
    expect(histAB[1].revokedReason).toBe('replaced_by_new_upload');

    // 3. GET /me devuelve la más reciente activa (cert B).
    const meB = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(meB.status).toBe(200);
    expect(meB.body.certNif).toBe('22222222B');
    expect(meB.body.revokedAt).toBeNull();

    // 4. DELETE /me revoca cert B. /me → 404. Histórico: 2 revocadas.
    const del = await request(app.getHttpServer())
      .delete('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'rotacion programada' });
    expect(del.status).toBe(204);

    const meAfterDel = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(meAfterDel.status).toBe(404);

    hist = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const histABRev: HistoryEntry[] = hist.body;
    expect(histABRev).toHaveLength(2);
    expect(histABRev.every((row) => row.revokedAt !== null)).toBe(true);
    expect(histABRev.find((r) => r.certNif === '22222222B')?.revokedReason).toBe(
      'rotacion programada',
    );
    expect(histABRev.find((r) => r.certNif === '11111111A')?.revokedReason).toBe(
      'replaced_by_new_upload',
    );

    // 5. Upload cert C → 201. /me devuelve C. Histórico tiene 3 entries
    //    (A y B revocadas; C activa).
    const certC = buildTestPkcs12({ commonName: 'CERT C', nifInSerialNumber: '33333333C' });
    const upC = await uploadCert(app, owner.accessToken, certC, 'c.p12');
    expect(upC.status).toBe(201);

    const meC = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(meC.status).toBe(200);
    expect(meC.body.certNif).toBe('33333333C');

    hist = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const histABC: HistoryEntry[] = hist.body;
    expect(histABC).toHaveLength(3);
    const activeRows = histABC.filter((r) => r.revokedAt === null);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].certNif).toBe('33333333C');
    expect(histABC.find((r) => r.certNif === '11111111A')?.revokedAt).not.toBeNull();
    expect(histABC.find((r) => r.certNif === '22222222B')?.revokedAt).not.toBeNull();
  });

  it('cross-tenant: cada tenant solo ve su propio histórico (RLS)', async () => {
    const tenantA = await registerVerifiedUser(app, 'aeat-hist-a');
    const tenantB = await registerVerifiedUser(app, 'aeat-hist-b');

    await uploadCert(
      app,
      tenantA.accessToken,
      buildTestPkcs12({ nifInSerialNumber: '44444444D', commonName: 'CERT TENANT A' }),
      'a.p12',
    ).then((r) => expect(r.status).toBe(201));
    await uploadCert(
      app,
      tenantB.accessToken,
      buildTestPkcs12({ nifInSerialNumber: '55555555E', commonName: 'CERT TENANT B' }),
      'b.p12',
    ).then((r) => expect(r.status).toBe(201));

    const histA = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${tenantA.accessToken}`);
    expect(histA.status).toBe(200);
    expect(histA.body).toHaveLength(1);
    expect((histA.body as HistoryEntry[])[0].certNif).toBe('44444444D');

    const histB = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${tenantB.accessToken}`);
    expect(histB.status).toBe(200);
    expect(histB.body).toHaveLength(1);
    expect((histB.body as HistoryEntry[])[0].certNif).toBe('55555555E');
  });

  it('rol staff -> 403 al consultar /history', async () => {
    const owner = await registerVerifiedUser(app, 'aeat-hist-rbac');
    const staffEmail = `staff-aeat-hist-${Date.now()}@e2e.local`;
    await deleteAllMessages();

    await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: staffEmail, role: 'staff' })
      .expect(201);

    const mail = await waitForEmail(staffEmail, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');

    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Staff AEAT Hist', password: 'Secret123' });
    expect(accept.status).toBe(200);
    const staffToken = accept.body.accessToken as string;

    const res = await request(app.getHttpServer())
      .get('/billing/aeat-credentials/history')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });
});
