import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupSuperAdmins, extractSuperAdminRefreshCookie } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';
import { generateTotpCode } from './helpers/totp';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Helper: espera hasta que `predicate` devuelva true. Necesario porque
 * `SuperAdminAuditService.record` se ejecuta tras await dentro del flow del
 * caller; con timeout corto evitamos flakiness.
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

describe('Fase 12A.3: super admin audit logs (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;
  let superAdminId: string;
  const adminEmail = 'audit-logs-admin@storageos.local';
  const adminPassword = 'AdminTest!23';

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

    // Limpieza inicial: borramos residuos previos.
    await adminClient.superAdminAuditLog.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: adminEmail } });

    const created = await adminClient.superAdmin.create({
      data: {
        email: adminEmail,
        passwordHash: await argonHash(adminPassword),
        fullName: 'Audit Logs Admin',
        role: 'superadmin',
      },
    });
    superAdminId = created.id;

    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword });
    if (login.status !== 200) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdminAuditLog.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: adminEmail } });
    await adminClient.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  // --------------------------------------------------------------------------
  // 1) Login admin OK -> admin.login.success
  // --------------------------------------------------------------------------
  it('login OK persiste admin.login.success con superAdminId, ipAddress y userAgent', async () => {
    const ua = 'audit-logs-e2e/login-success';
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('User-Agent', ua)
      .send({ email: adminEmail, password: adminPassword });
    expect(res.status).toBe(200);

    const log = await waitFor(() =>
      adminClient.superAdminAuditLog.findFirst({
        where: { action: 'admin.login.success', superAdminId, userAgent: ua },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(log.superAdminId).toBe(superAdminId);
    expect(log.userAgent).toBe(ua);
    expect(log.ipAddress).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // 2) Login con password incorrecto -> admin.login.failed (superAdminId set)
  // --------------------------------------------------------------------------
  it('login con password incorrecto persiste admin.login.failed con reason=wrong_password', async () => {
    const ua = 'audit-logs-e2e/login-bad-pwd';
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('User-Agent', ua)
      .send({ email: adminEmail, password: 'WrongPassword!99' });
    expect(res.status).toBe(401);

    const log = await waitFor(() =>
      adminClient.superAdminAuditLog.findFirst({
        where: { action: 'admin.login.failed', userAgent: ua },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(log.superAdminId).toBe(superAdminId);
    expect((log.changes as { reason?: string }).reason).toBe('wrong_password');
  });

  it('login con email inexistente persiste admin.login.failed con superAdminId=null', async () => {
    const ua = 'audit-logs-e2e/login-no-email';
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('User-Agent', ua)
      .send({ email: 'ghost-jamas@storageos.local', password: 'WhateverPassword99' });
    expect(res.status).toBe(401);

    const log = await waitFor(() =>
      adminClient.superAdminAuditLog.findFirst({
        where: { action: 'admin.login.failed', userAgent: ua },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(log.superAdminId).toBeNull();
    const changes = log.changes as { email?: string; reason?: string };
    expect(changes.email).toBe('ghost-jamas@storageos.local');
    expect(changes.reason).toBe('email_not_found');
  });

  // --------------------------------------------------------------------------
  // 3) Impersonate -> admin.tenant.impersonate con targetTenantId
  // --------------------------------------------------------------------------
  it('impersonate persiste admin.tenant.impersonate con targetTenantId', async () => {
    const owner = await registerVerifiedUser(app, 'audit-imp');
    const ua = 'audit-logs-e2e/impersonate';
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('User-Agent', ua)
      .send({ reason: 'support test impersonation' });
    expect([200, 201]).toContain(res.status);

    const log = await waitFor(() =>
      adminClient.superAdminAuditLog.findFirst({
        where: { action: 'admin.tenant.impersonate', targetTenantId: owner.tenantId },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(log.superAdminId).toBe(superAdminId);
    expect(log.targetTenantId).toBe(owner.tenantId);
    expect(log.targetId).toBe(owner.tenantId);
    expect(log.targetType).toBe('tenant');
    expect((log.changes as { reason?: string }).reason).toBe('support test impersonation');
  });

  // --------------------------------------------------------------------------
  // 4 + 5) Setup + Disable 2FA -> admin.2fa.enabled / admin.2fa.disabled
  // --------------------------------------------------------------------------
  it('setup + verify 2FA persiste admin.2fa.enabled, disable persiste admin.2fa.disabled', async () => {
    const email2fa = 'audit-2fa-admin@storageos.local';
    const password = 'AdminTest!23';
    await adminClient.superAdmin.deleteMany({ where: { email: email2fa } });
    const created = await adminClient.superAdmin.create({
      data: {
        email: email2fa,
        passwordHash: await argonHash(password),
        fullName: 'Audit 2FA Admin',
        role: 'superadmin',
      },
    });
    const adminId = created.id;

    try {
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: email2fa, password });
      expect(login.status).toBe(200);
      const token = login.body.accessToken as string;

      const setup = await request(app.getHttpServer())
        .post('/admin/auth/2fa/setup')
        .set('Authorization', `Bearer ${token}`);
      expect(setup.status).toBe(200);
      const secret = setup.body.secretBase32 as string;

      const verify = await request(app.getHttpServer())
        .post('/admin/auth/2fa/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: generateTotpCode(secret) });
      expect(verify.status).toBe(200);

      const enabledLog = await waitFor(() =>
        adminClient.superAdminAuditLog.findFirst({
          where: { action: 'admin.2fa.enabled', superAdminId: adminId },
          orderBy: { occurredAt: 'desc' },
        }),
      );
      expect(enabledLog.superAdminId).toBe(adminId);

      // Disable. Las sesiones se revocan: pasamos cookie + access token.
      const refreshCookie = extractSuperAdminRefreshCookie(login.headers);
      const disable = await request(app.getHttpServer())
        .post('/admin/auth/2fa/disable')
        .set('Authorization', `Bearer ${token}`)
        .set('Cookie', refreshCookie ?? '')
        .send({ password });
      expect(disable.status).toBe(204);

      const disabledLog = await waitFor(() =>
        adminClient.superAdminAuditLog.findFirst({
          where: { action: 'admin.2fa.disabled', superAdminId: adminId },
          orderBy: { occurredAt: 'desc' },
        }),
      );
      expect(disabledLog.superAdminId).toBe(adminId);
    } finally {
      await adminClient.superAdminAuditLog.deleteMany({ where: { superAdminId: adminId } });
      await adminClient.superAdminRecoveryCode.deleteMany({ where: { superAdminId: adminId } });
      await adminClient.superAdminSession.deleteMany({ where: { superAdminId: adminId } });
      await adminClient.superAdmin.delete({ where: { id: adminId } });
    }
  });

  // --------------------------------------------------------------------------
  // 6) Listado /admin/audit-logs -> super admin ve sus propias entradas
  // --------------------------------------------------------------------------
  it('GET /admin/audit-logs lista entradas y respeta filtro por action', async () => {
    const list = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ action: 'admin.login.success', limit: 50 });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    // Hay al menos uno (creado en el test 1).
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const item of list.body.items as Array<{ action: string }>) {
      expect(item.action).toBe('admin.login.success');
    }
  });

  // --------------------------------------------------------------------------
  // 7) Filtro por targetTenantId
  // --------------------------------------------------------------------------
  it('GET /admin/audit-logs filtra por targetTenantId', async () => {
    const owner = await registerVerifiedUser(app, 'audit-tgt');
    // Generamos una accion contra ese tenant.
    const suspend = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'audit logs filter test' });
    expect([200, 201]).toContain(suspend.status);

    // Esperamos a que la entrada se persista (es awaited despues del update).
    await waitFor(() =>
      adminClient.superAdminAuditLog.findFirst({
        where: { action: 'admin.tenant.suspended', targetTenantId: owner.tenantId },
      }),
    );

    const list = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ targetTenantId: owner.tenantId, limit: 50 });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const item of list.body.items as Array<{ targetTenantId: string | null }>) {
      expect(item.targetTenantId).toBe(owner.tenantId);
    }
  });

  // --------------------------------------------------------------------------
  // 8) Paginacion cursor
  // --------------------------------------------------------------------------
  it('GET /admin/audit-logs pagina con cursor', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items.length).toBeLessThanOrEqual(2);

    if (page1.body.nextCursor) {
      const page2 = await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ limit: 2, cursor: page1.body.nextCursor });
      expect(page2.status).toBe(200);
      // No deben solaparse los ids (cursor + skip:1).
      const ids1 = new Set(page1.body.items.map((i: { id: string }) => i.id));
      for (const i of page2.body.items as Array<{ id: string }>) {
        expect(ids1.has(i.id)).toBe(false);
      }
    }
  });

  // --------------------------------------------------------------------------
  // 9) Tenant user (no admin) -> 401 en /admin/audit-logs
  // --------------------------------------------------------------------------
  it('tenant user (no admin) GET /admin/audit-logs -> 401', async () => {
    const tenantUser = await registerVerifiedUser(app, 'audit-no-admin');
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${tenantUser.accessToken}`);
    expect(res.status).toBe(401);
  });

  it('sin auth GET /admin/audit-logs -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/admin/audit-logs');
    expect(res.status).toBe(401);
  });
});
