import { ConfigService } from '@nestjs/config';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient, type SecurityEventType } from '@storageos/database';
import request from 'supertest';

import { SecurityAlertsService } from '../src/modules/security-events/security-alerts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { Env } from '../src/config/env.schema';
import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ALERT_EMAIL = 'security-alerts-admin@e2e.local';
const SUPER_ADMIN_EMAIL = 'sec-alerts-superadmin@storageos.local';
const SUPER_ADMIN_PASSWORD = 'AdminTest!23';

/**
 * Inserta N eventos de tipo `eventType` directamente via PrismaAdmin,
 * todos dentro de la ventana actual. No pasamos por el flujo HTTP de
 * login porque argon2 lo haria lentisimo (5 fallos = ~1s minimo).
 */
async function seedSecurityEvents(
  admin: PrismaClient,
  args: {
    count: number;
    eventType: SecurityEventType;
    emailAttempted?: string;
    ipAddress?: string;
    tenantSlugAttempted?: string;
  },
): Promise<void> {
  const data = Array.from({ length: args.count }, (_, idx) => ({
    eventType: args.eventType,
    emailAttempted: args.emailAttempted ?? null,
    ipAddress: args.ipAddress ?? null,
    tenantSlugAttempted: args.tenantSlugAttempted ?? null,
    reason: `e2e-seed-${idx}`,
  }));
  // createMany es batch y mas rapido. Las columnas raw_metadata quedan NULL.
  await admin.securityEvent.createMany({ data });
}

describe('Fase 12A.2: security alerts brute-force (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;
  let alertsService: SecurityAlertsService;
  let config: ConfigService<Env, true>;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.securityEvent.deleteMany({});

    // Super admin para autenticar el endpoint manual de scan.
    await adminClient.superAdmin.deleteMany({ where: { email: SUPER_ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: SUPER_ADMIN_EMAIL,
        passwordHash: await argonHash(SUPER_ADMIN_PASSWORD),
        fullName: 'Sec Alerts Super Admin',
        role: 'superadmin',
      },
    });

    app = await createTestApp();
    alertsService = app.get(SecurityAlertsService);
    config = app.get<ConfigService<Env, true>>(ConfigService);

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.securityEvent.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: SUPER_ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  beforeEach(async () => {
    // Cada test debe arrancar con BD y mailbox limpios y dedup vacio.
    await adminClient.securityEvent.deleteMany({});
    await deleteAllMessages();
    alertsService.resetDedup();
  });

  it('sin SECURITY_ALERT_EMAIL configurado -> alertsSent=0 y no envia nada', async () => {
    const spy = stubConfig(config, { alertEmail: undefined });
    try {
      // Seedeamos 10 fallos para asegurarnos de que NO se envia.
      await seedSecurityEvents(adminClient, {
        count: 10,
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'noalert@e2e.local',
      });

      const result = await alertsService.scanAndAlert();
      expect(result.alertsSent).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('5 fallos del mismo email -> 1 alerta a Mailpit con subject correcto', async () => {
    const spy = stubAlertEmail(config);
    try {
      const target = 'bf-target@e2e.local';
      await seedSecurityEvents(adminClient, {
        count: 5,
        eventType: 'login_failed_wrong_password',
        emailAttempted: target,
      });

      const result = await alertsService.scanAndAlert();
      expect(result.alertsSent).toBeGreaterThanOrEqual(1);

      const mail = await waitForEmail(ALERT_EMAIL, {
        subjectIncludes: '[TrasterOS] Posible brute-force: email=',
      });
      expect(mail.Subject).toContain(target);
      expect(mail.Subject).toContain('15min');
      // El cuerpo debe mencionar el count (>=5; podria haber mas por IP null).
      expect(mail.HTML).toMatch(/<strong>5<\/strong>/);
    } finally {
      spy.mockRestore();
    }
  });

  it('4 fallos (por debajo del threshold) -> no envia alerta', async () => {
    const spy = stubAlertEmail(config);
    try {
      await seedSecurityEvents(adminClient, {
        count: 4,
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'belowthresh@e2e.local',
      });

      const result = await alertsService.scanAndAlert();
      expect(result.alertsSent).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('5 fallos desde la misma IP -> envia alerta con kind=ip', async () => {
    const spy = stubAlertEmail(config);
    try {
      // Cada evento con email distinto pero misma IP para que solo
      // agrupe por IP (no por email).
      const ip = '203.0.113.42';
      for (let i = 0; i < 5; i++) {
        await adminClient.securityEvent.create({
          data: {
            eventType: 'login_failed_email_not_found',
            emailAttempted: `attacker-${i}@e2e.local`,
            ipAddress: ip,
            reason: 'seed-ip',
          },
        });
      }

      const result = await alertsService.scanAndAlert();
      expect(result.alertsSent).toBeGreaterThanOrEqual(1);

      const mail = await waitForEmail(ALERT_EMAIL, {
        subjectIncludes: '[TrasterOS] Posible brute-force: ip=',
      });
      expect(mail.Subject).toContain(ip);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-scan inmediato con los mismos fallos -> NO envia duplicado', async () => {
    const spy = stubAlertEmail(config);
    try {
      const target = 'dedup@e2e.local';
      await seedSecurityEvents(adminClient, {
        count: 6,
        eventType: 'login_failed_wrong_password',
        emailAttempted: target,
      });

      const first = await alertsService.scanAndAlert();
      expect(first.alertsSent).toBeGreaterThanOrEqual(1);

      // Esperamos el primer email para evitar race.
      await waitForEmail(ALERT_EMAIL, { subjectIncludes: target });
      await deleteAllMessages();

      // Segundo scan inmediato sobre los mismos eventos: dedup debe filtrar.
      const second = await alertsService.scanAndAlert();
      expect(second.alertsSent).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('POST /admin/security-alerts/scan con super admin -> 200 + alertsSent', async () => {
    const spy = stubAlertEmail(config);
    try {
      await seedSecurityEvents(adminClient, {
        count: 5,
        eventType: 'login_failed_wrong_password',
        emailAttempted: 'manual-scan@e2e.local',
      });

      const res = await request(app.getHttpServer())
        .post('/admin/security-alerts/scan')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.alertsSent).toBe('number');
      expect(res.body.alertsSent).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('POST /admin/security-alerts/scan con tenant user -> 401', async () => {
    const owner = await registerVerifiedUser(app, 'sec-alerts-deny');
    const res = await request(app.getHttpServer())
      .post('/admin/security-alerts/scan')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(401);
  });
});

/**
 * Stub de `ConfigService.get` que cubre las claves usadas por
 * `SecurityAlertsService`. Para cualquier otra clave delega al
 * `get` original (capturado antes de spyear).
 *
 * Tipamos con `any` puntualmente porque `ConfigService.get` tiene multiples
 * sobrecargas y la firma `MockImplementation` choca con su tipo generico.
 */
function stubConfig(
  config: ConfigService<Env, true>,
  opts: { alertEmail?: string | undefined } = { alertEmail: ALERT_EMAIL },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): jest.SpyInstance<any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalGet = (config.get as (...args: any[]) => unknown).bind(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.spyOn(config as any, 'get').mockImplementation((...args: unknown[]) => {
    const key = args[0] as keyof Env;
    if (key === 'SECURITY_ALERT_EMAIL') return opts.alertEmail;
    if (key === 'SECURITY_BRUTE_FORCE_THRESHOLD') return 5;
    if (key === 'SECURITY_BRUTE_FORCE_WINDOW_MINUTES') return 15;
    if (key === 'WEB_BASE_URL') return 'http://localhost:3000';
    return originalGet(...args);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubAlertEmail(config: ConfigService<Env, true>): jest.SpyInstance<any, any> {
  return stubConfig(config, { alertEmail: ALERT_EMAIL });
}
