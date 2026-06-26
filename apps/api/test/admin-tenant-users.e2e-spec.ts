import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-tu-test@storageos.local';

describe('Admin tenant users (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin TU Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('lista los usuarios del tenant con sus datos', async () => {
    const owner = await registerVerifiedUser(app, 'admin-tu');

    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/users`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    const me = res.body.find((u: { email: string }) => u.email === owner.email);
    expect(me).toBeTruthy();
    expect(me.role).toBe('owner');
    expect(me.isActive).toBe(true);
    expect(me.emailVerified).toBe(true);
    expect(me.facilitiesCount).toBe(0);
    expect(me).toHaveProperty('twoFactorEnabled');
    expect(me).toHaveProperty('createdAt');

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get(`/admin/tenants/${owner.tenantId}/users`);
    expect(noAuth.status).toBe(401);

    // Tenant inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/users')
      .set('Authorization', `Bearer ${token}`);
    expect(ghost.status).toBe(404);
  });

  it('devuelve el resumen de facturación del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'admin-inv');

    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/invoicing`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Tenant recién creado: sin facturas, totales a 0 y 12 meses en la serie.
    expect(res.body.totalInvoiced).toBe(0);
    expect(res.body.totalCollected).toBe(0);
    expect(res.body.invoiceCount).toBe(0);
    expect(res.body.overdueCount).toBe(0);
    expect(res.body.currency).toBeTruthy();
    expect(Array.isArray(res.body.monthly)).toBe(true);
    expect(res.body.monthly).toHaveLength(12);
    expect(res.body.monthly[0]).toHaveProperty('label');
    expect(res.body.monthly[0]).toHaveProperty('invoiced');
    expect(res.body.monthly[0]).toHaveProperty('collected');

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get(
      `/admin/tenants/${owner.tenantId}/invoicing`,
    );
    expect(noAuth.status).toBe(401);

    // Tenant inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/invoicing')
      .set('Authorization', `Bearer ${token}`);
    expect(ghost.status).toBe(404);
  });

  it('lista los inquilinos del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'admin-cust');

    // Tenant nuevo sin inquilinos
    const empty = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/customers`)
      .set('Authorization', `Bearer ${token}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get(
      `/admin/tenants/${owner.tenantId}/customers`,
    );
    expect(noAuth.status).toBe(401);

    // Tenant inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/customers')
      .set('Authorization', `Bearer ${token}`);
    expect(ghost.status).toBe(404);
  });

  it('expone los locales del tenant y el desglose de trasteros', async () => {
    const owner = await registerVerifiedUser(app, 'admin-fac');

    // El detalle trae facilityCount
    const detail = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toHaveProperty('facilityCount');
    expect(detail.body.facilityCount).toBe(0);

    // Lista de locales (tenant nuevo → vacía)
    const facilities = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/facilities`)
      .set('Authorization', `Bearer ${token}`);
    expect(facilities.status).toBe(200);
    expect(facilities.body).toEqual([]);

    // Trasteros de un local inexistente -> 404
    const ghostUnits = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/facilities/00000000-0000-0000-0000-000000000000/units`)
      .set('Authorization', `Bearer ${token}`);
    expect(ghostUnits.status).toBe(404);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get(
      `/admin/tenants/${owner.tenantId}/facilities`,
    );
    expect(noAuth.status).toBe(401);
  });
});
