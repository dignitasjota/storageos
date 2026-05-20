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

describe('Fase 8: super admin + impersonation + support tickets (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    // Seed super admin para los tests
    await adminClient.superAdmin.deleteMany({ where: { email: 'admin-test@storageos.local' } });
    await adminClient.superAdmin.create({
      data: {
        email: 'admin-test@storageos.local',
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin-test@storageos.local', password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({
      where: { email: 'admin-test@storageos.local' },
    });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('super admin: login + me + tenants list', async () => {
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin-test@storageos.local', password: 'AdminTest!23' });
    expect([200, 201]).toContain(login.status);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.admin.email).toBe('admin-test@storageos.local');

    const me = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('admin-test@storageos.local');

    const tenants = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(tenants.status).toBe(200);
    expect(Array.isArray(tenants.body)).toBe(true);
  });

  it('super admin: login con password incorrecto -> 401', async () => {
    const r = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin-test@storageos.local', password: 'wrong-password' });
    expect(r.status).toBe(401);
  });

  it('tenant action: extend-trial suma dias', async () => {
    const owner = await registerVerifiedUser(app, 'admin-extend');
    const before = await adminClient.tenant.findUnique({ where: { id: owner.tenantId } });
    const trialEndsBefore = before?.trialEndsAt?.getTime() ?? 0;

    const r = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/extend-trial`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ days: 7, reason: 'test extension' });
    expect([200, 201]).toContain(r.status);

    const after = await adminClient.tenant.findUnique({ where: { id: owner.tenantId } });
    const trialEndsAfter = after?.trialEndsAt?.getTime() ?? 0;
    expect(trialEndsAfter).toBeGreaterThan(trialEndsBefore);
  });

  it('tenant action: suspend → reactivate', async () => {
    const owner = await registerVerifiedUser(app, 'admin-sus');
    const suspend = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'test' });
    expect([200, 201]).toContain(suspend.status);

    const after = await adminClient.tenant.findUnique({ where: { id: owner.tenantId } });
    expect(after?.status).toBe('suspended');

    const reactivate = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/reactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'test' });
    expect([200, 201]).toContain(reactivate.status);
  });

  it('impersonate: genera token + log de impersonacion', async () => {
    const owner = await registerVerifiedUser(app, 'admin-imp');
    const r = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'soporte ticket 123' });
    expect([200, 201]).toContain(r.status);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.body.tenantSlug).toBeTruthy();

    const log = await adminClient.impersonationLog.findFirst({
      where: { tenantId: owner.tenantId },
    });
    expect(log).toBeTruthy();
    expect(log?.reason).toBe('soporte ticket 123');
  });

  it('support tickets: tenant crea + admin lo ve + admin responde', async () => {
    const owner = await registerVerifiedUser(app, 'admin-supp');

    const create = await request(app.getHttpServer())
      .post('/support/tickets')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ subject: 'Necesito ayuda', body: 'No me cargan los trasteros', priority: 'normal' });
    expect(create.status).toBe(201);
    const ticketId = create.body.id;

    const listTenant = await request(app.getHttpServer())
      .get('/support/tickets')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(listTenant.status).toBe(200);
    expect(listTenant.body.length).toBeGreaterThanOrEqual(1);

    const listAdmin = await request(app.getHttpServer())
      .get('/admin/support/tickets')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(listAdmin.status).toBe(200);
    expect(listAdmin.body.some((t: { id: string }) => t.id === ticketId)).toBe(true);

    const reply = await request(app.getHttpServer())
      .post(`/admin/support/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ body: 'Estamos investigando, gracias.', isInternal: false });
    expect([200, 201]).toContain(reply.status);
  });
});
