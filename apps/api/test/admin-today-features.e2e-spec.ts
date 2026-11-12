import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { TodayWatchService } from '../src/modules/admin/today-watch.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

describe('Mejoras de «Hoy» del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let adminId: string;

  const today = async () =>
    (await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200)).body;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.adminTodaySnooze.deleteMany({});
    app = await createTestApp();
    const admin = await seedSuperAdmin('today-features');
    adminId = admin.id;
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await db.adminTodaySnooze.deleteMany({});
    await db.platformLead.deleteMany({ where: { email: 'today-e2e@e2e.local' } });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.$disconnect();
  });

  it('un aviso apartado no sale ni cuenta hasta recuperarlo', async () => {
    const contact = await db.platformLead.create({
      data: { contactName: 'Visitante', email: 'today-e2e@e2e.local', source: 'web_contact' },
    });
    const before = await today();
    expect(before.newLeads.some((c: { id: string }) => c.id === contact.id)).toBe(true);

    await request(app.getHttpServer())
      .post('/admin/today/snoozes')
      .set(auth)
      .send({ kind: 'contact', ref: contact.id, label: 'Visitante', days: 7 })
      .expect(204);
    const apart = await today();
    expect(apart.newLeads.some((c: { id: string }) => c.id === contact.id)).toBe(false);
    expect(apart.urgentCount).toBe(before.urgentCount - 1);

    const snooze = apart.snoozes.find((s: { ref: string }) => s.ref === contact.id);
    await request(app.getHttpServer())
      .delete(`/admin/today/snoozes/${snooze.id}`)
      .set(auth)
      .expect(204);
    const back = await today();
    expect(back.newLeads.some((c: { id: string }) => c.id === contact.id)).toBe(true);
  });

  it('avisa de pruebas sin arrancar y enseña cuánto usa cada prueba', async () => {
    const owner = await registerVerifiedUser(app, 'today-stalled');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: {
        createdAt: new Date(Date.now() - 9 * DAY),
        status: 'trial',
        trialEndsAt: new Date(Date.now() + 3 * DAY),
      },
    });
    const body = await today();
    const stalled = body.activationStalled.find(
      (a: { tenantId: string }) => a.tenantId === owner.tenantId,
    );
    expect(stalled).toMatchObject({ missing: 'facility', ownerEmail: owner.email });
    const trial = body.trialsExpiring.find((t: { id: string }) => t.id === owner.tenantId);
    expect(trial.usage).toMatchObject({ facilities: 0, units: 0, contracts: 0 });
  });

  it('dominios listos, facturas sin NIF, reparto y lo cerrado hoy', async () => {
    const owner = await registerVerifiedUser(app, 'today-notices');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: {
        customDomain: `today-${Date.now()}.example.com`,
        customDomainReadyAt: new Date(),
      },
    });
    const followup = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({
        title: 'Llamar',
        dueDate: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10),
      })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/admin/followups/${followup.body.id}`)
      .set(auth)
      .send({ assignedToId: adminId })
      .expect(200);

    const body = await today();
    expect(body.domainsReady.some((d: { tenantId: string }) => d.tenantId === owner.tenantId)).toBe(
      true,
    );
    expect(body.followupsUpcoming.some((f: { id: string }) => f.id === followup.body.id)).toBe(
      true,
    );
    expect(body.followupsDue.some((f: { id: string }) => f.id === followup.body.id)).toBe(false);
    const mine = body.workload.find((w: { superAdminId: string }) => w.superAdminId === adminId);
    expect(mine.followups).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .patch(`/admin/followups/${followup.body.id}`)
      .set(auth)
      .send({ status: 'done' })
      .expect(200);
    expect((await today()).done.followupsDone).toBeGreaterThanOrEqual(1);
  });

  it('una renovación con días por delante no cuenta como urgente', async () => {
    const owner = await registerVerifiedUser(app, 'today-week');
    const before = (await today()).urgentCount;
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'active',
        billingMode: 'manual',
        currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      },
    });
    const body = await today();
    expect(
      body.manualRenewalsDue.some((r: { tenantId: string }) => r.tenantId === owner.tenantId),
    ).toBe(true);
    expect(body.urgentCount).toBe(before);
  });

  it('las cifras traen con qué compararlas', async () => {
    const { kpis } = await today();
    expect(typeof kpis.collectedPrev7d).toBe('number');
    expect(typeof kpis.newPrevMonthToDate).toBe('number');
    expect('mrrPrevMonth' in kpis).toBe(true);
  });

  it('avisa al momento de un ticket urgente, una vez, y se puede apagar', async () => {
    const owner = await registerVerifiedUser(app, 'today-instant');
    const ticket = await db.supportTicket.create({
      data: {
        tenantId: owner.tenantId,
        subject: `Puerta rota ${Date.now()}`,
        priority: 'urgent',
        category: 'trasteros',
        status: 'open',
      },
    });
    const watch = app.get(TodayWatchService);
    await db.platformAlertSettings.updateMany({ data: { instantAlertsEnabled: false } });
    const settings = await db.platformAlertSettings.count();
    if (settings > 0) expect((await watch.check()).lines).toHaveLength(0);
    await db.platformAlertSettings.updateMany({ data: { instantAlertsEnabled: true } });

    const first = await watch.check();
    expect(first.lines.some((l) => l.includes(ticket.subject))).toBe(true);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'today.attention', body: { contains: ticket.subject } },
    });
    expect(notice).not.toBeNull();
    const second = await watch.check();
    expect(second.lines.some((l) => l.includes(ticket.subject))).toBe(false);
    await db.securityAlertState.deleteMany({ where: { kind: 'today' } });
  });
});
