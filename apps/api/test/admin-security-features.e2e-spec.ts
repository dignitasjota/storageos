import { getQueueToken } from '@nestjs/bullmq';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SecurityAlertsService } from '../src/modules/admin/security-alerts.service';
import { SystemWatchService } from '../src/modules/admin/system-watch.service';
import { QUEUE_REPORTS } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const refreshCookie = (headers: Record<string, unknown>): string => {
  const raw = headers['set-cookie'] as unknown as string[] | undefined;
  return ((raw ?? []).find((c) => c.startsWith('super_admin_refresh=')) ?? '').split(
    ';',
  )[0] as string;
};

describe('Mejoras de seguridad y sistema del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminAuth(prefix: string) {
    const admin = await seedSuperAdmin(prefix);
    const session = await login(admin.email, admin.password);
    return { admin, session, auth: bearer(session.body.accessToken) };
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.securityBlock.deleteMany({});
    app = await createTestApp();
  });

  afterAll(async () => {
    await db.securityBlock.deleteMany({});
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.$disconnect();
  });

  it('un email bloqueado no entra aunque la contraseña sea buena, y se puede desbloquear', async () => {
    const { auth, admin } = await adminAuth('feat-block');
    const owner = await registerVerifiedUser(app, 'secblock');
    const credentials = {
      tenantSlug: owner.slug,
      email: owner.email,
      password: owner.password,
    };

    await request(app.getHttpServer())
      .post('/admin/security-blocks')
      .set(auth)
      .send({ kind: 'email', value: owner.email, expiresInHours: 1 })
      .expect(204);
    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(401);
    const event = await db.securityEvent.findFirst({
      where: { eventType: 'login_blocked', emailAttempted: owner.email },
    });
    expect(event).not.toBeNull();

    const list = await request(app.getHttpServer())
      .get('/admin/security-blocks')
      .set(auth)
      .expect(200);
    const block = list.body.find((b: { value: string }) => b.value === owner.email);
    await request(app.getHttpServer())
      .delete(`/admin/security-blocks/${block.id}`)
      .set(auth)
      .expect(204);
    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(200);

    const self = await request(app.getHttpServer())
      .post('/admin/security-blocks')
      .set(auth)
      .send({ kind: 'email', value: admin.email });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('cannot_block_self');
    await request(app.getHttpServer())
      .post('/admin/security-blocks')
      .set(auth)
      .send({ kind: 'ip', value: 'no-es-ip' })
      .expect(400);
  });

  it('se ven las sesiones abiertas y se cierra una o todas', async () => {
    const { admin, session, auth } = await adminAuth('feat-sessions');
    const other = await login(admin.email, admin.password);

    const list = await request(app.getHttpServer())
      .get('/admin/auth/sessions')
      .set(auth)
      .set('Cookie', refreshCookie(session.headers))
      .expect(200);
    expect(list.body).toHaveLength(2);
    const current = list.body.find((s: { current: boolean }) => s.current);
    const remote = list.body.find((s: { current: boolean }) => !s.current);
    expect(current).toBeDefined();

    await request(app.getHttpServer())
      .delete(`/admin/auth/sessions/${remote.id}`)
      .set(auth)
      .expect(204);
    await request(app.getHttpServer())
      .post('/admin/auth/refresh')
      .set('Cookie', refreshCookie(other.headers))
      .expect(401);

    const boss = await adminAuth('feat-sessions-boss');
    const seen = await request(app.getHttpServer())
      .get(`/admin/super-admins/${admin.id}/sessions`)
      .set(boss.auth)
      .expect(200);
    expect(seen.body).toHaveLength(1);
    const closed = await request(app.getHttpServer())
      .post(`/admin/super-admins/${admin.id}/revoke-sessions`)
      .set(boss.auth)
      .expect(200);
    expect(closed.body.revoked).toBe(1);
  });

  it('una sesión reutilizada avisa sin esperar al umbral', async () => {
    const alerts = app.get(SecurityAlertsService);
    await alerts.resetDedup();
    const email = `reuse-${Date.now()}@e2e.local`;
    await db.securityEvent.create({
      data: { eventType: 'refresh_token_reuse', emailAttempted: email },
    });

    const first = await alerts.scanAndAlert();
    expect(first.alertsSent).toBeGreaterThanOrEqual(1);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'security.brute_force', body: { contains: email } },
    });
    expect(notice?.title).toContain('Sesión reutilizada');
    expect((await alerts.scanAndAlert()).alertsSent).toBe(0);
    await db.securityEvent.deleteMany({ where: { emailAttempted: email } });
  });

  it('la actividad de una impersonación es solo lo que hizo el soporte, y se avisa al propietario', async () => {
    const { auth } = await adminAuth('feat-imp');
    const owner = await registerVerifiedUser(app, 'secimp');

    const entered = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set(auth)
      .send({ reason: 'Revisar un error del cliente', readOnly: false });
    expect(entered.status).toBeLessThan(300);
    await waitForEmail(owner.email, { subjectIncludes: 'soporte de TrasterOS' });

    await request(app.getHttpServer())
      .post('/customers')
      .set(bearer(entered.body.accessToken))
      .send({ customerType: 'individual', firstName: 'Del', lastName: 'Soporte' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/customers')
      .set(bearer(owner.accessToken))
      .send({ customerType: 'individual', firstName: 'Del', lastName: 'Propietario' })
      .expect(201);

    const sessions = await request(app.getHttpServer())
      .get(`/admin/impersonation-logs?tenantId=${owner.tenantId}`)
      .set(auth)
      .expect(200);
    const session = sessions.body.items[0];
    expect(session.actionsCount).toBe(1);
    const activity = await request(app.getHttpServer())
      .get(`/admin/impersonation-logs/${session.id}/activity`)
      .set(auth)
      .expect(200);
    expect(activity.body).toHaveLength(1);
  });

  it('una cola se pausa y se reanuda, y sus fallidos se listan por páginas', async () => {
    const { auth } = await adminAuth('feat-queues');
    const queue = app.get<Queue>(getQueueToken(QUEUE_REPORTS));

    await request(app.getHttpServer())
      .post(`/admin/queues/${queue.name}/pause`)
      .set(auth)
      .expect(200);
    const paused = await request(app.getHttpServer()).get('/admin/queues').set(auth).expect(200);
    expect(paused.body.find((q: { name: string }) => q.name === queue.name).paused).toBe(true);
    await request(app.getHttpServer())
      .post(`/admin/queues/${queue.name}/resume`)
      .set(auth)
      .expect(200);

    const failed = await request(app.getHttpServer())
      .get(`/admin/queues/${queue.name}/failed?page=1`)
      .set(auth)
      .expect(200);
    expect(failed.body).toMatchObject({ page: 1, pageSize: 25 });
  });

  it('una tarea con más de una hora de retraso avisa una sola vez', async () => {
    const name = `feat-watch-${Date.now()}`;
    await db.cronHeartbeat.create({
      data: {
        name,
        process: 'api',
        expression: '* * * * *',
        nextRunAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    const watch = app.get(SystemWatchService);
    try {
      const first = await watch.check();
      expect(first.problems.some((p) => p.includes(name))).toBe(true);
      const second = await watch.check();
      expect(second.problems.some((p) => p.includes(name))).toBe(false);
    } finally {
      await db.cronHeartbeat.delete({ where: { name } });
      await db.securityAlertState.deleteMany({ where: { kind: 'system' } });
    }
  });
});
