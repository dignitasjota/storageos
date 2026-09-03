import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inviteStaff(
  app: INestApplication,
  ownerToken: string,
): Promise<{ token: string; email: string; password: string }> {
  const email = `notif-staff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const password = 'Passw0rd!';
  const inv = await request(app.getHttpServer())
    .post('/invitations')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role: 'staff' });
  if (inv.status !== 201) throw new Error(`invite ${inv.status}: ${JSON.stringify(inv.body)}`);
  const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
  const token = extractToken(mail.Text, '/invite');
  const accept = await request(app.getHttpServer())
    .post(`/invitations/token/${token}/accept`)
    .send({ fullName: 'Staff', password });
  if (accept.status !== 200) throw new Error(`accept ${accept.status}`);
  return { token: accept.body.accessToken as string, email, password };
}

describe('Notifications + revenue KPIs (e2e)', () => {
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

  it('feed vacío por defecto', async () => {
    const owner = await registerVerifiedUser(app, 'notif-empty');
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unreadCount: 0 });
  });

  it('crear un lead genera una notificación; marcar leída baja el contador', async () => {
    const owner = await registerVerifiedUser(app, 'notif-lead');
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ firstName: 'Carla', lastName: 'Ruiz', email: 'carla@e2e.local' });
    expect(lead.status).toBe(201);

    // El listener es async: reintenta hasta que aparezca la notificación.
    let body: { items: { id: string; type: string }[]; unreadCount: number } | null = null;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      body = res.body;
      if ((body?.unreadCount ?? 0) > 0) break;
      await sleep(300);
    }
    expect(body?.unreadCount).toBeGreaterThan(0);
    const notif = body!.items.find((n) => n.type === 'lead.created');
    expect(notif).toBeTruthy();

    const read = await request(app.getHttpServer())
      .post(`/notifications/${notif!.id}/read`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(read.status).toBe(204);

    const after = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.body.unreadCount).toBe(0);
  });

  it('un rol personalizado sin notifications:read no accede; con él, sí (antes ningún endpoint exigía permiso)', async () => {
    const owner = await registerVerifiedUser(app, 'notif-perm');
    const staff = await inviteStaff(app, owner.accessToken);

    // Rol custom SIN notifications:read (solo un permiso irrelevante) →
    // el guard debe cortar aunque la sesión esté autenticada.
    const restricted = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Sin notificaciones', permissions: ['customers:read'], baseRole: 'staff' });
    expect(restricted.status).toBe(201);

    const users = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const staffUser = (users.body as { id: string; email: string }[]).find(
      (u) => u.email === staff.email,
    );
    expect(staffUser).toBeTruthy();

    await request(app.getHttpServer())
      .patch(`/settings/users/${staffUser!.id}/tenant-role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ tenantRoleId: restricted.body.id })
      .expect(204);

    const relogin1 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: staff.email, password: staff.password });
    const tokenRestricted = relogin1.body.accessToken as string;

    const blocked = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenRestricted}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('insufficient_permission');

    const blockedRead = await request(app.getHttpServer())
      .post('/notifications/read-all')
      .set('Authorization', `Bearer ${tokenRestricted}`);
    expect(blockedRead.status).toBe(403);

    // Rol custom CON notifications:read → pasa el guard.
    const allowed = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Con notificaciones', permissions: ['notifications:read'], baseRole: 'staff' });
    expect(allowed.status).toBe(201);

    await request(app.getHttpServer())
      .patch(`/settings/users/${staffUser!.id}/tenant-role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ tenantRoleId: allowed.body.id })
      .expect(204);

    const relogin2 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: staff.email, password: staff.password });
    const tokenAllowed = relogin2.body.accessToken as string;

    const ok = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenAllowed}`);
    expect(ok.status).toBe(200);
  });

  it('revenue KPIs: tenant vacío devuelve ceros', async () => {
    const owner = await registerVerifiedUser(app, 'notif-revenue');
    const res = await request(app.getHttpServer())
      .get('/analytics/revenue')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mrr: 0, totalUnits: 0, revPau: 0 });
  });
});
