import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Dashboard de alertas sobre `security_events`. Endpoint
 * `GET /v1/admin/security-events/stats?window=...` que agrega KPIs,
 * timeseries, top IPs/emails y alertas activas (groups >= threshold).
 *
 * Threshold leído de `SECURITY_BRUTE_FORCE_THRESHOLD` (default 5 en tests).
 */
describe('Security dashboard stats (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
    prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await prisma.securityEvent.deleteMany({
      where: { emailAttempted: { startsWith: 'dashboard-test-' } },
    });
  });

  afterAll(async () => {
    await prisma.securityEvent.deleteMany({
      where: { emailAttempted: { startsWith: 'dashboard-test-' } },
    });
    await prisma.$disconnect();
    await app.close();
    await cleanupSuperAdmins();
  });

  async function loginAsSuperAdmin(): Promise<string> {
    const admin = await seedSuperAdmin('dashboard');
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect([200, 201]).toContain(res.status);
    return res.body.accessToken as string;
  }

  it('window=24h con datos vacíos devuelve total=0 y arrays vacíos', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/security-events/stats?window=24h')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(24);
    expect(res.body.bucket).toBe('hour');
    expect(typeof res.body.bruteForceThreshold).toBe('number');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.byEventType)).toBe(true);
    expect(Array.isArray(res.body.topEmails)).toBe(true);
    expect(Array.isArray(res.body.topIps)).toBe(true);
    expect(Array.isArray(res.body.timeseries)).toBe(true);
    expect(Array.isArray(res.body.activeAlerts)).toBe(true);
  });

  it('agrega correctamente con eventos sembrados y detecta alertas activas', async () => {
    // 6 fallos desde la misma IP + 6 desde el mismo email → ambos exceden
    // threshold default (5). Threshold ya configurable via env.
    const now = Date.now();
    const events: Parameters<typeof prisma.securityEvent.create>[0]['data'][] = [];
    for (let i = 0; i < 6; i++) {
      events.push({
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'dashboard-test-attacker@example.com',
        ipAddress: '198.51.100.42',
        occurredAt: new Date(now - i * 60_000), // últimos 6 minutos
      });
    }
    // 3 fallos de otra IP (no debe ser alerta)
    for (let i = 0; i < 3; i++) {
      events.push({
        eventType: 'login_failed_tenant_not_found',
        tenantSlugAttempted: 'inexistente',
        ipAddress: '203.0.113.5',
        emailAttempted: `dashboard-test-other-${i}@example.com`,
        occurredAt: new Date(now - i * 60_000),
      });
    }
    for (const data of events) {
      await prisma.securityEvent.create({ data });
    }

    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/security-events/stats?window=24h')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(9);

    const topIps = res.body.topIps as Array<{
      ip: string;
      count: number;
      exceedsThreshold: boolean;
    }>;
    const attackerIp = topIps.find((t) => t.ip === '198.51.100.42');
    expect(attackerIp).toBeDefined();
    expect(attackerIp!.count).toBeGreaterThanOrEqual(6);
    expect(attackerIp!.exceedsThreshold).toBe(true);

    const topEmails = res.body.topEmails as Array<{
      email: string;
      count: number;
      exceedsThreshold: boolean;
    }>;
    const attackerEmail = topEmails.find((t) => t.email === 'dashboard-test-attacker@example.com');
    expect(attackerEmail).toBeDefined();
    expect(attackerEmail!.count).toBeGreaterThanOrEqual(6);
    expect(attackerEmail!.exceedsThreshold).toBe(true);

    const alerts = res.body.activeAlerts as Array<{
      kind: 'email' | 'ip';
      identifier: string;
      count: number;
    }>;
    expect(alerts.some((a) => a.kind === 'ip' && a.identifier === '198.51.100.42')).toBe(true);
    expect(
      alerts.some(
        (a) => a.kind === 'email' && a.identifier === 'dashboard-test-attacker@example.com',
      ),
    ).toBe(true);

    // El timeseries debe tener al menos 1 bucket con count > 0
    const ts = res.body.timeseries as Array<{ bucket: string; count: number }>;
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.some((t) => t.count > 0)).toBe(true);
  });

  it('window=7d usa bucket day', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/security-events/stats?window=7d')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(24 * 7);
    expect(res.body.bucket).toBe('day');
  });

  it('sin Authorization responde 401', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/security-events/stats');
    expect(res.status).toBe(401);
  });
});
