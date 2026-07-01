import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Banner global (el super admin lo activa → el tenant lo lee) y feed de
 * notificaciones del super admin (un ticket nuevo genera una notificación).
 */
describe('Banner global + notificaciones admin (e2e)', () => {
  let app: INestApplication;
  let adminAuth: { Authorization: string };
  let tenantAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();

    const owner = await registerVerifiedUser(app, 'banner');
    tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const admin = await seedSuperAdmin('banner');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('el banner activado lo ve el tenant; desactivado no', async () => {
    // Sin activar → el tenant no ve banner (null → body vacío).
    const off = await request(app.getHttpServer()).get('/platform-banner').set(tenantAuth);
    expect(off.status).toBe(200);
    expect(off.body?.enabled ?? false).toBe(false);

    // El admin activa un banner.
    await request(app.getHttpServer())
      .put('/admin/platform/banner')
      .set(adminAuth)
      .send({ message: 'Mantenimiento el domingo', level: 'warning', enabled: true })
      .expect(200);

    const on = await request(app.getHttpServer()).get('/platform-banner').set(tenantAuth);
    expect(on.body.message).toBe('Mantenimiento el domingo');
    expect(on.body.level).toBe('warning');
    expect(on.body.enabled).toBe(true);
  });

  it('un ticket nuevo genera una notificación en el feed del admin', async () => {
    const before = await request(app.getHttpServer())
      .get('/admin/platform/notifications/unread-count')
      .set(adminAuth);
    const baseCount = before.body.count as number;

    await request(app.getHttpServer())
      .post('/support/tickets')
      .set(tenantAuth)
      .send({ subject: 'No puedo emitir facturas', body: 'Ayuda', priority: 'high' })
      .expect(201);

    const notifs = await request(app.getHttpServer())
      .get('/admin/platform/notifications')
      .set(adminAuth);
    expect(notifs.status).toBe(200);
    const ticketNotif = notifs.body.find((n: { type: string }) => n.type === 'support_ticket');
    expect(ticketNotif).toBeTruthy();
    expect(ticketNotif.link).toMatch(/^\/admin\/support\//);

    const after = await request(app.getHttpServer())
      .get('/admin/platform/notifications/unread-count')
      .set(adminAuth);
    expect(after.body.count).toBeGreaterThan(baseCount);

    // Marcar todas leídas → contador a 0.
    await request(app.getHttpServer())
      .post('/admin/platform/notifications/read-all')
      .set(adminAuth)
      .expect(204);
    const cleared = await request(app.getHttpServer())
      .get('/admin/platform/notifications/unread-count')
      .set(adminAuth);
    expect(cleared.body.count).toBe(0);
  });
});
