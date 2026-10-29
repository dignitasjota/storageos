import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-tenants-improve@storageos.local';
const OTHER_EMAIL = 'admin-tenants-improve-2@storageos.local';

/** Mejoras del apartado Tenants del panel admin. */
describe('Admin: mejoras del apartado Tenants (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let otherToken: string;
  let adminId: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, OTHER_EMAIL] } } });
    const hash = await argonHash('AdminTest!23');
    const a = await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hash,
        fullName: 'Admin Mejoras',
        role: 'superadmin',
      },
    });
    adminId = a.id;
    await db.superAdmin.create({
      data: { email: OTHER_EMAIL, passwordHash: hash, fullName: 'Otro Admin', role: 'support' },
    });
    app = await createTestApp();
    const login = async (email: string) =>
      (await http().post('/admin/auth/login').send({ email, password: 'AdminTest!23' })).body
        .accessToken as string;
    token = await login(ADMIN_EMAIL);
    otherToken = await login(OTHER_EMAIL);
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, OTHER_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('da de alta un tenant a mano con el propietario verificado y le manda el enlace', async () => {
    const email = `alta-${Date.now()}@e2e.local`;
    const res = await http()
      .post('/admin/tenants')
      .set(admin())
      .send({
        tenantName: 'E2E Alta Manual',
        ownerName: 'Ana Manual',
        ownerEmail: email,
        planSlug: 'pro',
        trialDays: 0,
        note: 'Venta en feria',
      })
      .expect(201);
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: res.body.tenantId },
      include: { subscription: { include: { plan: true } } },
    });
    expect(tenant.status).toBe('active');
    expect(tenant.subscription?.plan.slug).toBe('pro');
    const owner = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(owner.emailVerifiedAt).not.toBeNull();
    const mail = await waitForEmail(email, { subjectIncludes: 'elige tu contraseña' });
    expect(mail.Text).toContain('/reset-password/');
    expect(await db.tenantInteraction.count({ where: { tenantId: tenant.id } })).toBe(1);

    // El soporte no da de alta.
    await http()
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${otherToken}` })
      .send({
        tenantName: 'X',
        ownerName: 'X',
        ownerEmail: 'x@e2e.local',
        planSlug: 'pro',
        trialDays: 0,
      })
      .expect(403);
  });

  it('reactiva perdonando el periodo y anonimizar pide confirmar la exportación', async () => {
    const owner = await registerVerifiedUser(app, 'impforgive');
    const pastEnd = new Date(Date.now() - 10 * 86_400_000);
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'suspended' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'past_due', currentPeriodEnd: pastEnd },
    });
    await http()
      .post(`/admin/tenants/${owner.tenantId}/reactivate`)
      .set(admin())
      .send({ reason: 'Pago acordado', forgivePeriod: true })
      .expect(200);
    const sub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/anonymize-preview`)
      .set(admin())
      .expect(200);
    expect(preview.body).toMatchObject({ users: 1, invoicesKept: 0 });
    await http()
      .post(`/admin/tenants/${owner.tenantId}/anonymize`)
      .set(admin())
      .send({ reason: 'Baja' })
      .expect(400);
  });

  it('«ignorar» saca al tenant de En riesgo y los trials traen su uso', async () => {
    const owner = await registerVerifiedUser(app, 'impsnooze');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { trialEndsAt: new Date(Date.now() + 2 * 86_400_000) },
    });
    const before = await http().get('/admin/tenants/at-risk').set(admin()).expect(200);
    expect(before.body.trialExpiring.map((t: { id: string }) => t.id)).toContain(owner.tenantId);
    expect(Array.isArray(before.body.lowHealth)).toBe(true);

    await http()
      .post(`/admin/tenants/${owner.tenantId}/risk-snooze`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .send({ days: 30, reason: 'Ya hablado con él' })
      .expect(200);
    const after = await http().get('/admin/tenants/at-risk').set(admin()).expect(200);
    expect(after.body.trialExpiring.map((t: { id: string }) => t.id)).not.toContain(owner.tenantId);
    expect(after.body.snoozedCount).toBeGreaterThanOrEqual(1);
    await http().delete(`/admin/tenants/${owner.tenantId}/risk-snooze`).set(admin()).expect(204);

    const trials = await http().get('/admin/tenants/trials').set(admin()).expect(200);
    const row = trials.body.find((t: { id: string }) => t.id === owner.tenantId);
    expect(row).toMatchObject({ facilities: 0, units: 0, activeContracts: 0 });
  });

  it('dominio propio: comprueba el DNS y dice si su plan lo incluye', async () => {
    const owner = await registerVerifiedUser(app, 'impdomain');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { customDomain: `ready-${Date.now()}.example.com` },
    });
    const check = await http()
      .post(`/admin/tenants/${owner.tenantId}/custom-domain/check`)
      .set(admin())
      .expect(200);
    expect(check.body.pointsToPlatform).toBe(true);
    const list = await http().get('/admin/tenants/custom-domains').set(admin()).expect(200);
    const row = list.body.find((d: { tenantId: string }) => d.tenantId === owner.tenantId);
    expect(row.dnsReadyAt).not.toBeNull();
    expect(row.featureEnabled).toBe(false); // starter no lo incluye
  });

  it('seguimientos con quién se encarga, «los míos» y posponer', async () => {
    const owner = await registerVerifiedUser(app, 'impfollow');
    const created = await http()
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(admin())
      .send({ title: 'Llamar', dueDate: '2030-01-10', assignedToId: adminId })
      .expect(201);
    expect(created.body.assignedToName).toBe('Admin Mejoras');
    const mine = await http().get('/admin/followups?mine=1').set(admin()).expect(200);
    expect(mine.body.map((f: { id: string }) => f.id)).toContain(created.body.id);
    const notMine = await http()
      .get('/admin/followups?mine=1')
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(200);
    expect(notMine.body.map((f: { id: string }) => f.id)).not.toContain(created.body.id);
    const moved = await http()
      .patch(`/admin/followups/${created.body.id}`)
      .set(admin())
      .send({ dueDate: '2030-02-01' })
      .expect(200);
    expect(moved.body).toMatchObject({ dueDate: '2030-02-01', status: 'pending' });
    await http()
      .patch(`/admin/followups/${created.body.id}`)
      .set(admin())
      .send({ assignedToId: '00000000-0000-0000-0000-000000000000' })
      .expect(400);
  });

  it('historial con hitos, sesiones de un usuario, AEAT y vistas guardadas', async () => {
    const owner = await registerVerifiedUser(app, 'imptools');
    const timeline = await http()
      .get(`/admin/tenants/${owner.tenantId}/timeline?kinds=milestone`)
      .set(admin())
      .expect(200);
    expect(timeline.body.items.map((i: { title: string }) => i.title)).toContain(
      'Alta en TrasterOS',
    );

    const sessions = await http()
      .get(`/admin/tenants/${owner.tenantId}/users/${owner.userId}/sessions`)
      .set(admin())
      .expect(200);
    expect(sessions.body.length).toBeGreaterThanOrEqual(1);
    await http()
      .delete(
        `/admin/tenants/${owner.tenantId}/users/${owner.userId}/sessions/${sessions.body[0].id}`,
      )
      .set(admin())
      .expect(204);
    const left = await http()
      .get(`/admin/tenants/${owner.tenantId}/users/${owner.userId}/sessions`)
      .set(admin())
      .expect(200);
    expect(left.body.length).toBe(sessions.body.length - 1);

    const customerId = await createCustomer(app, owner.accessToken, { email: 'aeat@e2e.local' });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http()
      .post(`/invoices/${invoiceId}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    const resent = await http()
      .post(`/admin/billing-health/invoices/${invoiceId}/resend-aeat`)
      .set(admin());
    expect([200, 400]).toContain(resent.status);
    await http()
      .post('/admin/billing-health/invoices/00000000-0000-0000-0000-000000000000/refresh-aeat')
      .set(admin())
      .expect(404);

    const saved = await http()
      .post('/admin/saved-views')
      .set(admin())
      .send({ page: 'tenants', name: 'Con deuda', filters: { overdue: true } })
      .expect(201);
    await http()
      .post('/admin/saved-views')
      .set(admin())
      .send({ page: 'tenants', name: 'Con deuda', filters: { overdue: false } })
      .expect(201);
    const views = await http().get('/admin/saved-views?page=tenants').set(admin()).expect(200);
    expect(views.body).toHaveLength(1);
    expect(views.body[0].filters).toEqual({ overdue: false });
    // Cada uno ve y borra solo las suyas.
    await http()
      .delete(`/admin/saved-views/${saved.body.id}`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
    await http().delete(`/admin/saved-views/${saved.body.id}`).set(admin()).expect(204);
  });
});
