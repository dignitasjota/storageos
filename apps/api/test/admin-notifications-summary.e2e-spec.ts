import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Página de notificaciones del super admin + resumen de la ficha del tenant. */
describe('Admin: notificaciones y resumen del tenant (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: Record<string, string>;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('notifs-summary');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
  });

  afterAll(async () => {
    await app.close();
    await db.superAdminNotification.deleteMany({ where: { type: 'e2e.notifs' } });
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('pagina las notificaciones, filtra las sin leer y marca una como leída', async () => {
    await db.superAdminNotification.deleteMany({ where: { type: 'e2e.notifs' } });
    for (let i = 0; i < 3; i++) {
      await db.superAdminNotification.create({
        data: { type: 'e2e.notifs', title: `Aviso ${i}`, createdAt: new Date(Date.now() + i) },
      });
    }
    const first = await request(app.getHttpServer())
      .get('/admin/platform/notifications/page?limit=2&unread=true')
      .set(auth)
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app.getHttpServer())
      .get(`/admin/platform/notifications/page?limit=2&unread=true&cursor=${first.body.nextCursor}`)
      .set(auth)
      .expect(200);
    const ids = [...first.body.items, ...second.body.items].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    const target = first.body.items[0].id as string;
    await request(app.getHttpServer())
      .post(`/admin/platform/notifications/${target}/read`)
      .set(auth)
      .expect(204);
    const unread = await request(app.getHttpServer())
      .get('/admin/platform/notifications/page?limit=100&unread=true')
      .set(auth)
      .expect(200);
    expect(unread.body.items.map((n: { id: string }) => n.id)).not.toContain(target);

    await request(app.getHttpServer())
      .get('/admin/platform/notifications/page?cursor=nope')
      .set(auth)
      .expect(400);
    await request(app.getHttpServer()).get('/admin/platform/notifications/page').expect(401);
  });

  it('resume lo que aporta, el equipo, la facturación y el soporte del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'summary');
    const tAuth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Res' });
    const inv = await request(app.getHttpServer())
      .post('/invoices')
      .set(tAuth)
      .send({
        customerId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/invoices/${inv.body.id}/issue`)
      .set(tAuth)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${inv.body.id}/mark-paid`)
      .set(tAuth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/support/tickets')
      .set(tAuth)
      .send({ subject: 'Una duda', body: 'Hola', priority: 'normal' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/summary`)
      .set(auth)
      .expect(200);
    expect(res.body).toMatchObject({
      activeUsers: 1,
      invoices30d: 1,
      invoiced30d: 121,
      collected30d: 121,
      overdueInvoices: 0,
      openTickets: 1,
      billingExempt: false,
    });
    expect(typeof res.body.effectiveMonthly).toBe('number');
    expect('lastTeamLoginAt' in res.body).toBe(true);

    await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/summary')
      .set(auth)
      .expect(404);
  });
});
