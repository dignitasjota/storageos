import { getQueueToken } from '@nestjs/bullmq';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { QUEUE_REPORTS } from '../src/modules/queues/queues.module';

import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const refreshCookie = (headers: Record<string, unknown>): string => {
  const raw = headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((c) => c.startsWith('super_admin_refresh='));
  return (cookie ?? '').split(';')[0] as string;
};

describe('Revisión de seguridad y sistema del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await db.platformSecuritySettings.deleteMany({});
    app = await createTestApp();
  });

  afterAll(async () => {
    await db.platformSecuritySettings.deleteMany({});
    await app.close();
    await cleanupSuperAdmins();
    await db.$disconnect();
  });

  it('un fallo al entrar al panel queda en los eventos de seguridad y se puede filtrar', async () => {
    const admin = await seedSuperAdmin('sec-review-events');
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('X-Forwarded-For', '198.51.100.77')
      .send({ email: admin.email, password: 'contraseña-mala-123' })
      .expect(401);

    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);
    const part = admin.email.slice(0, 20);
    const events = await request(app.getHttpServer())
      .get(`/admin/security-events?emailAttempted=${part}&eventType=admin_login_failed`)
      .set(auth)
      .expect(200);
    expect(events.body.items[0]).toMatchObject({
      eventType: 'admin_login_failed',
      emailAttempted: admin.email,
      reason: 'wrong_password',
    });

    await request(app.getHttpServer())
      .get('/admin/security-events?ipAddress=no-es-una-ip')
      .set(auth)
      .expect(400);
  });

  it('el escaneo de alertas es solo para el rol superadmin', async () => {
    const support = await seedSuperAdmin('sec-review-support');
    await db.superAdmin.update({ where: { id: support.id }, data: { role: 'support' } });
    const session = await login(support.email, support.password);
    await request(app.getHttpServer())
      .post('/admin/security-alerts/scan')
      .set(bearer(session.body.accessToken))
      .expect(403);
  });

  it('dos refrescos seguidos del mismo navegador no cierran la sesión', async () => {
    const admin = await seedSuperAdmin('sec-review-grace');
    const session = await login(admin.email, admin.password);
    const cookie = refreshCookie(session.headers);

    const first = await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', cookie);
    expect(first.status).toBe(200);
    const second = await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    // La cookie de la primera respuesta sigue viva.
    await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', refreshCookie(first.headers))
      .expect(200);
  });

  it('una respuesta perdida se recupera pasado el margen; una sesión ya usada revoca todo', async () => {
    const admin = await seedSuperAdmin('sec-review-lost');
    const session = await login(admin.email, admin.password);
    const cookie = refreshCookie(session.headers);
    const first = await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', cookie)
      .expect(200);

    const old = new Date(Date.now() - 5 * 60_000);
    await db.superAdminSession.updateMany({
      where: { superAdminId: admin.id, rotatedAt: { not: null } },
      data: { rotatedAt: old },
    });

    // La cookie nueva nunca llegó al móvil: el token anterior la sustituye.
    const recovered = await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', cookie);
    expect(recovered.status).toBe(200);
    await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', refreshCookie(first.headers))
      .expect(401);
  });

  it('cerrar sesión deja sin valor el access token y cambiar la contraseña pide la actual', async () => {
    const admin = await seedSuperAdmin('sec-review-logout');
    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);

    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set(auth)
      .send({ currentPassword: 'no-es-la-buena', newPassword: 'OtraContraseña!123' })
      .expect(403);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app.getHttpServer())
      .post('/admin/auth/logout')
      .set(auth)
      .set('Cookie', refreshCookie(session.headers))
      .expect(204);
    await request(app.getHttpServer()).get('/admin/auth/me').set(auth).expect(401);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await login(admin.email, admin.password);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set(bearer(again.body.accessToken))
      .send({ currentPassword: admin.password, newPassword: 'OtraContraseña!123' })
      .expect(204);
    await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set(bearer(again.body.accessToken))
      .expect(401);
    expect((await login(admin.email, 'OtraContraseña!123')).status).toBe(200);
  });

  it('recuperar la contraseña: enlace de un solo uso y sin decir si el email existe', async () => {
    const admin = await seedSuperAdmin('sec-review-reset');
    await deleteAllMessages();
    await request(app.getHttpServer())
      .post('/admin/auth/password/forgot')
      .send({ email: 'nadie-sec-review@storageos.local' })
      .expect(204);
    await request(app.getHttpServer())
      .post('/admin/auth/password/forgot')
      .send({ email: admin.email })
      .expect(204);

    const mail = await waitForEmail(admin.email, { subjectIncludes: 'contraseña' });
    const token = extractToken(mail.Text, '/admin/reset-password');

    await request(app.getHttpServer())
      .post('/admin/auth/password/reset')
      .send({ token, newPassword: 'NuevaClave!12345' })
      .expect(204);
    expect((await login(admin.email, 'NuevaClave!12345')).status).toBe(200);
    const replay = await request(app.getHttpServer())
      .post('/admin/auth/password/reset')
      .send({ token, newPassword: 'OtraClave!123456' });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('invalid_token');
  });

  it('el alta sin contraseña envía el enlace y el rol se cambia con sus guardas', async () => {
    const admin = await seedSuperAdmin('sec-review-role');
    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);
    const email = `test-2fa-invite-${Date.now()}@storageos.local`;

    const created = await request(app.getHttpServer())
      .post('/admin/super-admins')
      .set(auth)
      .send({ email, fullName: 'Persona Invitada', role: 'support' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'acceso' });
    expect(extractToken(mail.Text, '/admin/reset-password')).toContain(created.body.id);

    const up = await request(app.getHttpServer())
      .patch(`/admin/super-admins/${created.body.id}/role`)
      .set(auth)
      .send({ role: 'superadmin' })
      .expect(200);
    expect(up.body.role).toBe('superadmin');

    const self = await request(app.getHttpServer())
      .patch(`/admin/super-admins/${admin.id}/role`)
      .set(auth)
      .send({ role: 'support' });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('cannot_modify_self');
  });

  it('la 2FA obligatoria: no se activa sin tenerla y pasado el plazo solo deja la cuenta', async () => {
    const admin = await seedSuperAdmin('sec-review-policy');
    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);

    const denied = await request(app.getHttpServer())
      .put('/admin/security-settings')
      .set(auth)
      .send({ requireAdminTwoFactor: true, adminTwoFactorGraceDays: 0 });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('own_two_factor_required');

    await db.platformSecuritySettings.create({
      data: {
        requireAdminTwoFactor: true,
        adminTwoFactorGraceDays: 0,
        adminTwoFactorRequiredSince: new Date(Date.now() - 60_000),
      },
    });
    await db.superAdmin.update({
      where: { id: admin.id },
      data: { createdAt: new Date(Date.now() - 86_400_000) },
    });
    try {
      const blocked = await request(app.getHttpServer()).get('/admin/tenants').set(auth);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('admin_two_factor_required');
      const status = await request(app.getHttpServer())
        .get('/admin/auth/2fa/status')
        .set(auth)
        .expect(200);
      expect(status.body.required).toBe(true);
    } finally {
      await db.platformSecuritySettings.deleteMany({});
    }
  });

  it('la limpieza de webhooks no baja de 7 días y las tareas retiradas salen de la lista', async () => {
    const admin = await seedSuperAdmin('sec-review-system');
    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);

    await request(app.getHttpServer())
      .post('/admin/webhooks-cleanup/run')
      .set(auth)
      .send({ olderThanDays: 3 })
      .expect(400);

    await db.cronHeartbeat.create({
      data: { name: 'sec-review.retirada', process: 'api', expression: '* * * * *' },
    });
    const removed = await request(app.getHttpServer())
      .delete('/admin/crons/sec-review.retirada')
      .set(auth)
      .expect(200);
    expect(removed.body.removed).toBe(1);

    // Una tarea no tiene UUID, pero la acción tiene que quedar en el registro.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logged = await db.superAdminAuditLog.findFirst({
      where: { action: 'admin.cron.removed', superAdminId: admin.id },
    });
    expect(logged?.changes).toMatchObject({ target: { name: 'sec-review.retirada' } });
  });

  it('un job fallido se reintenta o se elimina uno a uno', async () => {
    const admin = await seedSuperAdmin('sec-review-jobs');
    const session = await login(admin.email, admin.password);
    const auth = bearer(session.body.accessToken);
    const queue = app.get<Queue>(getQueueToken(QUEUE_REPORTS));

    await request(app.getHttpServer())
      .post(`/admin/queues/${queue.name}/jobs/no-existe/retry`)
      .set(auth)
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/admin/queues/${queue.name}/jobs/no-existe`)
      .set(auth)
      .expect(404);
  });
});
