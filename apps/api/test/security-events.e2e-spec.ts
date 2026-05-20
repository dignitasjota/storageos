import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SecurityEventsService } from '../src/modules/security-events/security-events.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Helper: espera hasta que `predicate` devuelva true. Necesario porque
 * `SecurityEventsService.record` se ejecuta tras el throw del controller
 * (await del audit + record) pero algunos paths podrian no estar
 * sincronizados; con timeout corto evitamos flakiness.
 */
async function waitFor<T>(
  predicate: () => Promise<T | null | undefined>,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await predicate();
    if (r) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error('waitFor timeout');
}

describe('Fase 11A.1: security events (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

    // Limpieza inicial: borramos cualquier evento residual de runs anteriores.
    await adminClient.securityEvent.deleteMany({});

    // Super admin para los endpoints `/admin/security-events`.
    await adminClient.superAdmin.deleteMany({
      where: { email: 'sec-events-admin@storageos.local' },
    });
    await adminClient.superAdmin.create({
      data: {
        email: 'sec-events-admin@storageos.local',
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Sec Events Admin',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'sec-events-admin@storageos.local', password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.securityEvent.deleteMany({});
    await adminClient.superAdmin.deleteMany({
      where: { email: 'sec-events-admin@storageos.local' },
    });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('login con tenant inexistente persiste login_failed_tenant_not_found', async () => {
    const ids = uniqueTestIds('sec-tenant');
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: ids.slug, email: ids.email, password: 'Secret123' });
    expect(r.status).toBe(401);

    const ev = await waitFor(() =>
      adminClient.securityEvent.findFirst({
        where: { eventType: 'login_failed_tenant_not_found', tenantSlugAttempted: ids.slug },
      }),
    );
    expect(ev).toBeTruthy();
    expect(ev.emailAttempted).toBe(ids.email);
  });

  it('login con email inexistente persiste login_failed_email_not_found', async () => {
    const owner = await registerVerifiedUser(app, 'sec-email');
    const otherIds = uniqueTestIds('sec-other');
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: otherIds.email, password: 'Secret123' });
    expect(r.status).toBe(401);

    const ev = await waitFor(() =>
      adminClient.securityEvent.findFirst({
        where: {
          eventType: 'login_failed_email_not_found',
          emailAttempted: otherIds.email,
          tenantSlugAttempted: owner.slug,
        },
      }),
    );
    expect(ev).toBeTruthy();
  });

  it('login con password incorrecto persiste login_failed_wrong_password', async () => {
    const owner = await registerVerifiedUser(app, 'sec-pwd');
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: owner.email, password: 'WrongPassword!' });
    expect(r.status).toBe(401);

    const ev = await waitFor(() =>
      adminClient.securityEvent.findFirst({
        where: {
          eventType: 'login_failed_wrong_password',
          emailAttempted: owner.email,
          tenantSlugAttempted: owner.slug,
        },
      }),
    );
    expect(ev).toBeTruthy();
  });

  it('super admin GET /admin/security-events devuelve la lista', async () => {
    const r = await request(app.getHttpServer())
      .get('/admin/security-events')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body).toHaveProperty('nextCursor');
    // Ordenacion: el primero es el mas reciente.
    const first = r.body.items[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('eventType');
    expect(first).toHaveProperty('occurredAt');
  });

  it('filtro por eventType funciona', async () => {
    const r = await request(app.getHttpServer())
      .get('/admin/security-events?eventType=login_failed_wrong_password')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const it of r.body.items) {
      expect(it.eventType).toBe('login_failed_wrong_password');
    }
  });

  it('filtro por emailAttempted funciona', async () => {
    const owner = await registerVerifiedUser(app, 'sec-filter');
    // Generamos un evento concreto con su email.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: owner.email, password: 'BadPwd123!' });

    const r = await request(app.getHttpServer())
      .get(`/admin/security-events?emailAttempted=${encodeURIComponent(owner.email)}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const it of r.body.items) {
      expect(it.emailAttempted).toBe(owner.email);
    }
  });

  it('paginacion cursor funciona (60 eventos -> pagina 50 + 10)', async () => {
    // Limpiamos para tener un dataset controlado.
    await adminClient.securityEvent.deleteMany({});

    // Insertamos 60 eventos directamente via admin (bypassa el flujo HTTP).
    const seedEmail = 'paginate@e2e.local';
    const rows = Array.from({ length: 60 }, (_, idx) => ({
      eventType: 'login_failed_email_not_found' as const,
      emailAttempted: seedEmail,
      reason: `seed-${idx}`,
    }));
    for (const r of rows) {
      await adminClient.securityEvent.create({ data: r });
      // Pausa minima para que `occurredAt` quede ordenado de forma determinista.
      await new Promise((res) => setTimeout(res, 2));
    }

    const page1 = await request(app.getHttpServer())
      .get(`/admin/security-events?emailAttempted=${seedEmail}&limit=50`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(50);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app.getHttpServer())
      .get(
        `/admin/security-events?emailAttempted=${seedEmail}&limit=50&cursor=${page1.body.nextCursor}`,
      )
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(10);
    expect(page2.body.nextCursor).toBeNull();

    // No hay overlap entre paginas.
    const ids1 = new Set<string>(page1.body.items.map((i: { id: string }) => i.id));
    for (const item of page2.body.items) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });

  it('cleanup borra eventos > 90 dias y preserva recientes', async () => {
    await adminClient.securityEvent.deleteMany({});
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const oldEvent = await adminClient.securityEvent.create({
      data: {
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'old@e2e.local',
        occurredAt: old,
      },
    });
    const recentEvent = await adminClient.securityEvent.create({
      data: {
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'recent@e2e.local',
        occurredAt: recent,
      },
    });

    const svc = app.get(SecurityEventsService);
    const result = await svc.cleanup(90);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const oldGone = await adminClient.securityEvent.findUnique({ where: { id: oldEvent.id } });
    expect(oldGone).toBeNull();
    const recentStill = await adminClient.securityEvent.findUnique({
      where: { id: recentEvent.id },
    });
    expect(recentStill).toBeTruthy();
  });

  it('tenant user (no admin) GET /admin/security-events -> 401', async () => {
    const owner = await registerVerifiedUser(app, 'sec-tenant-deny');
    const r = await request(app.getHttpServer())
      .get('/admin/security-events')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(r.status).toBe(401);
  });
});
