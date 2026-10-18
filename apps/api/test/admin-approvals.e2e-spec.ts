import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Cola de aprobación: el rol soporte pide, el super admin aprueba o rechaza. */
describe('Admin: cola de aprobación (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let superAuth: Record<string, string>;
  let supportAuth: Record<string, string>;

  async function login(email: string, password: string) {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password });
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const sa = await seedSuperAdmin('appr-super');
    superAuth = await login(sa.email, sa.password);
    const sup = await seedSuperAdmin('appr-support');
    await db.superAdmin.update({ where: { email: sup.email }, data: { role: 'support' } });
    supportAuth = await login(sup.email, sup.password);
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('soporte pide ampliar la prueba; el super admin la aprueba y se ejecuta', async () => {
    const t = await registerVerifiedUser(app, 'apprtrial');
    const http = () => request(app.getHttpServer());
    const before = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });

    // Soporte no puede hacerlo directamente…
    await http()
      .post(`/admin/tenants/${t.tenantId}/extend-trial`)
      .set(supportAuth)
      .send({ days: 10, reason: 'x' })
      .expect(403);
    // …pero sí pedirlo.
    await http()
      .post('/admin/approvals')
      .set(supportAuth)
      .send({
        tenantId: t.tenantId,
        reason: 'Lo pide el cliente',
        request: { action: 'extend_trial', payload: { days: 0, reason: 'x' } },
      })
      .expect(400);
    const created = await http()
      .post('/admin/approvals')
      .set(supportAuth)
      .send({
        tenantId: t.tenantId,
        reason: 'Lo pide el cliente',
        request: { action: 'extend_trial', payload: { days: 10, reason: 'Cliente' } },
      })
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'pending',
      action: 'extend_trial',
      summary: '10 días más',
      requestedByName: expect.any(String),
    });

    // Aparece en el «Hoy» y cuenta como urgente.
    const today = await http().get('/admin/today').set(superAuth).expect(200);
    expect(today.body.pendingApprovals.map((a: { id: string }) => a.id)).toContain(created.body.id);

    // Soporte no aprueba.
    await http()
      .post(`/admin/approvals/${created.body.id}/approve`)
      .set(supportAuth)
      .send({})
      .expect(403);

    const approved = await http()
      .post(`/admin/approvals/${created.body.id}/approve`)
      .set(superAuth)
      .send({ note: 'Ok' })
      .expect(200);
    expect(approved.body).toMatchObject({ status: 'approved', decisionNote: 'Ok', error: null });
    const after = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(after.trialEndsAt!.getTime() - before.trialEndsAt!.getTime()).toBe(10 * 86_400_000);

    // Ya resuelta → 409.
    await http()
      .post(`/admin/approvals/${created.body.id}/reject`)
      .set(superAuth)
      .send({})
      .expect(409);
    const list = await http()
      .get(`/admin/approvals?tenantId=${t.tenantId}`)
      .set(supportAuth)
      .expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('rechazar no ejecuta; una acción que falla queda «fallida» con el motivo', async () => {
    const t = await registerVerifiedUser(app, 'apprreject');
    const http = () => request(app.getHttpServer());

    const suspend = await http()
      .post('/admin/approvals')
      .set(supportAuth)
      .send({
        tenantId: t.tenantId,
        reason: 'Impago',
        request: { action: 'suspend', payload: { reason: 'Impago' } },
      })
      .expect(201);
    const rejected = await http()
      .post(`/admin/approvals/${suspend.body.id}/reject`)
      .set(superAuth)
      .send({ note: 'Esperamos' })
      .expect(200);
    expect(rejected.body.status).toBe('rejected');
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).status).not.toBe(
      'suspended',
    );

    const badPlan = await http()
      .post('/admin/approvals')
      .set(supportAuth)
      .send({
        tenantId: t.tenantId,
        reason: 'Upgrade',
        request: { action: 'change_plan', payload: { planSlug: 'no-existe', reason: 'x' } },
      })
      .expect(201);
    const failed = await http()
      .post(`/admin/approvals/${badPlan.body.id}/approve`)
      .set(superAuth)
      .send({})
      .expect(200);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.error).toBeTruthy();
  });
});
