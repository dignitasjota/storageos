import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const RANDOM_UUID = '00000000-0000-7000-8000-000000000000';

/** Invita a un usuario con el rol dado, acepta la invitación y devuelve su access token. */
async function inviteAndAccept(
  app: INestApplication,
  ownerToken: string,
  role: 'manager' | 'staff',
): Promise<string> {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const inv = await request(app.getHttpServer())
    .post('/invitations')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status}: ${JSON.stringify(inv.body)}`);
  const mail = await waitForEmail(inv.body.email, { subjectIncludes: 'invitado' });
  const token = extractToken(mail.Text, '/invite');
  const accept = await request(app.getHttpServer())
    .post(`/invitations/token/${token}/accept`)
    .send({ fullName: role, password: 'Passw0rd!' });
  if (accept.status !== 200) {
    throw new Error(`accept failed ${accept.status}: ${JSON.stringify(accept.body)}`);
  }
  return accept.body.accessToken as string;
}

describe('Permisos finos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('/auth/me incluye permisos del rol (owner = todos, incluye invoices:refund)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-me');
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions).toContain('invoices:refund');
    expect(res.body.permissions).toContain('settings:manage');
  });

  it('manager: permisos sin invoices:refund; el endpoint refund devuelve 403', async () => {
    const owner = await registerVerifiedUser(app, 'perm-mgr');
    const managerToken = await inviteAndAccept(app, owner.accessToken, 'manager');

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(me.body.permissions).not.toContain('invoices:refund');
    expect(me.body.permissions).toContain('invoices:manage'); // sí puede emitir

    // El guard rechaza ANTES de tocar el servicio (no importa que la factura no exista).
    const refund = await request(app.getHttpServer())
      .post(`/invoices/${RANDOM_UUID}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ amount: 10 });
    expect(refund.status).toBe(403);
    expect(refund.body.code).toBe('insufficient_permission');
  });

  it('owner sí pasa el guard de refund (404 por factura inexistente, no 403)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-owner-refund');
    const refund = await request(app.getHttpServer())
      .post(`/invoices/${RANDOM_UUID}/refund`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 10 });
    expect(refund.status).not.toBe(403);
    expect([400, 404]).toContain(refund.status);
  });

  it('staff: puede crear factura (invoices:write) pero no emitir (invoices:manage → 403)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-staff');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const issue = await request(app.getHttpServer())
      .post(`/invoices/${RANDOM_UUID}/issue`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(issue.status).toBe(403);
    expect(issue.body.code).toBe('insufficient_permission');
  });
});
