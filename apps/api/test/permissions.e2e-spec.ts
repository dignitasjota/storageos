import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
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

  // --- RBAC v2 (operativa migrada a @RequirePermission) ---

  it('manager: NO puede borrar un customer (customers:delete es solo owner → 403)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-cust-del');
    const managerToken = await inviteAndAccept(app, owner.accessToken, 'manager');

    const customerId = await createCustomer(app, owner.accessToken);

    // manager pierde el borrado (catálogo: borrados excluidos de manager).
    const asManager = await request(app.getHttpServer())
      .delete(`/customers/${customerId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(asManager.status).toBe(403);
    expect(asManager.body.code).toBe('insufficient_permission');

    // owner sí puede.
    const asOwner = await request(app.getHttpServer())
      .delete(`/customers/${customerId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(asOwner.status).toBe(204);
  });

  it('staff: puede crear y editar customers (customers:write)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-cust-write');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const customerId = await createCustomer(app, staffToken);
    expect(customerId).toBeTruthy();
  });

  // --- RBAC v2 PR2 (inventario / catálogo / comms a @RequirePermission) ---

  it('staff: pasa el guard de crear units (units:write — antes owner/manager)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-unit-write');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    // El guard de permisos corre antes de la validación del body: si staff
    // tiene units:write no recibe 403 (sí 400 por payload vacío).
    const res = await request(app.getHttpServer())
      .post('/units')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('staff: NO puede gestionar el catálogo de productos (products:manage → 403)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-prod-manage');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const res = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insufficient_permission');
  });

  it('staff: pasa el guard de vender productos (products:write)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-prod-sale');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const res = await request(app.getHttpServer())
      .post('/product-sales')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(res.status).not.toBe(403);
  });

  it('staff: pasa el guard de reintentar comunicaciones (communications:send — antes owner/manager)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-comms-retry');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const res = await request(app.getHttpServer())
      .post(`/communications/${RANDOM_UUID}/retry`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    // Guard pasa (communications:send) → 404 por comunicación inexistente, no 403.
    expect(res.status).not.toBe(403);
  });

  it('staff: NO puede crear automations (automations:manage → 403)', async () => {
    const owner = await registerVerifiedUser(app, 'perm-auto-manage');
    const staffToken = await inviteAndAccept(app, owner.accessToken, 'staff');

    const res = await request(app.getHttpServer())
      .post('/automations')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insufficient_permission');
  });
});
