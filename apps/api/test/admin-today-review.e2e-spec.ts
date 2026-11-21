import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminTodayExtrasService } from '../src/modules/admin/admin-today-extras.service';
import { AdminTodayService } from '../src/modules/admin/admin-today.service';
import { TodayWatchService } from '../src/modules/admin/today-watch.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const LEAD_EMAIL = 'today-review-e2e@e2e.local';
const ADDON_SLUG = 'e2e-today-review';

describe('Revisión de «Hoy» del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let adminId: string;

  const today = async () =>
    (await request(app.getHttpServer()).get('/admin/today?fresh=1').set(auth).expect(200)).body;
  const snooze = (kind: string, ref: string) =>
    request(app.getHttpServer())
      .post('/admin/today/snoozes')
      .set(auth)
      .send({ kind, ref, label: ref, days: 30 })
      .expect(204);

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.adminTodaySnooze.deleteMany({});
    await db.platformLead.deleteMany({ where: { email: LEAD_EMAIL } });
    await db.subscriptionAddon.deleteMany({ where: { slug: ADDON_SLUG } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('today-review');
    adminId = admin.id;
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await db.adminTodaySnooze.deleteMany({});
    await db.platformLead.deleteMany({ where: { email: LEAD_EMAIL } });
    await app.close();
    await cleanupTestTenants();
    await db.subscriptionAddon.deleteMany({ where: { slug: ADDON_SLUG } });
    await cleanupSuperAdmins();
    await db.$disconnect();
  });

  it('un ticket apartado vuelve a salir cuando el cliente escribe', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-ticket');
    const ticket = await request(app.getHttpServer())
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: 'No me deja entrar', body: 'Hola', priority: 'normal' })
      .expect(201);
    const id = ticket.body.id as string;
    // El primer mensaje, un rato antes: el segundo es claramente posterior.
    await db.$executeRaw`UPDATE support_ticket_messages SET created_at = now() - interval '1 hour' WHERE ticket_id = ${id}::uuid`;

    await snooze('ticket', id);
    const hidden = await today();
    expect(hidden.openTickets.some((t: { id: string }) => t.id === id)).toBe(false);
    expect(hidden.snoozes.some((s: { ref: string }) => s.ref === id)).toBe(true);

    await request(app.getHttpServer())
      .post(`/support/tickets/${id}/messages`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ body: '¿Hay alguien?' })
      .expect(201);
    const back = await today();
    const row = back.openTickets.find((t: { id: string }) => t.id === id);
    expect(row).toMatchObject({
      reappeared: true,
      reappearedReason: 'El cliente ha vuelto a escribir',
    });
    expect(back.snoozes.some((s: { ref: string }) => s.ref === id)).toBe(false);
  });

  it('un impago apartado vuelve a salir si sube la deuda', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-debt');
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        billingMode: 'manual',
        currentPeriodEnd: new Date(Date.now() - 5 * DAY),
      },
    });
    const before = (await today()).pastDue.find((t: { id: string }) => t.id === owner.tenantId);
    expect(before?.owedAmount).toBeGreaterThan(0);

    await snooze('past_due', owner.tenantId);
    expect((await today()).pastDue.some((t: { id: string }) => t.id === owner.tenantId)).toBe(
      false,
    );

    // Pasa otro mes sin pagar: dos cuotas.
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 40 * DAY) },
    });
    const row = (await today()).pastDue.find((t: { id: string }) => t.id === owner.tenantId);
    expect(row).toMatchObject({ reappeared: true, reappearedReason: 'La deuda ha subido' });
    expect(row.owedAmount).toBeGreaterThan(before.owedAmount);
  });

  it('las colas solo cuentan los fallidos de las últimas 24 h', async () => {
    // Las colas que mira «Hoy» (cada módulo registra su propia instancia).
    const queues = (app.get(AdminTodayService) as unknown as { queues: Queue[] }).queues;
    const spies = queues.map((queue, i) =>
      jest
        .spyOn(queue, 'getFailed')
        .mockResolvedValue(
          i === 0
            ? ([
                { finishedOn: Date.now() - 3 * DAY },
                { finishedOn: Date.now() - 60 * 60 * 1000 },
              ] as unknown as Job[])
            : [],
        ),
    );
    try {
      expect((await today()).failedJobs).toBe(1);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('una sección que falla no tumba la bandeja', async () => {
    const extras = app.get(AdminTodayExtrasService);
    const spy = jest.spyOn(extras, 'npsNegative').mockRejectedValue(new Error('boom'));
    try {
      const body = await today();
      expect(body.failedSections).toEqual(['npsNegative']);
      expect(body.npsNegative).toEqual([]);
      expect(Array.isArray(body.openTickets)).toBe(true);
      expect(typeof body.urgentCount).toBe('number');
    } finally {
      spy.mockRestore();
    }
    expect((await today()).failedSections).toEqual([]);
  });

  it('un lead asignado a un comercial no es urgente', async () => {
    const before = (await today()).urgentCount;
    const lead = await db.platformLead.create({
      data: {
        contactName: 'Asignado',
        email: LEAD_EMAIL,
        source: 'web_contact',
        assignedToId: adminId,
      },
    });
    const body = await today();
    // Recién asignado: lo lleva alguien y aún no sale como «sin atender».
    expect(body.newLeads.some((l: { id: string }) => l.id === lead.id)).toBe(false);
    expect(body.urgentCount).toBe(before);

    await db.platformLead.update({ where: { id: lead.id }, data: { assignedToId: null } });
    expect((await today()).urgentCount).toBe(before + 1);
  });

  it('un webhook que ya vuelve a funcionar no sale', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-hook');
    const webhook = await db.webhook.create({
      data: {
        tenantId: owner.tenantId,
        name: 'ERP',
        url: 'https://example.com/hook',
        secret: 'enc',
        events: ['invoice.paid'],
      },
    });
    const base = {
      tenantId: owner.tenantId,
      webhookId: webhook.id,
      eventType: 'invoice.paid',
      payload: {},
      signature: 'x',
      scheduledFor: new Date(),
    };
    await db.webhookDelivery.createMany({
      data: [
        { ...base, status: 'failed', attempts: 3, createdAt: new Date(Date.now() - 2 * DAY) },
        { ...base, status: 'success', statusCode: 200, createdAt: new Date(Date.now() - DAY) },
      ],
    });
    const fixed = await today();
    expect(
      fixed.failedWebhooks.some((w: { tenantId: string }) => w.tenantId === owner.tenantId),
    ).toBe(false);

    await db.webhookDelivery.create({
      data: { ...base, status: 'failed', attempts: 3, createdAt: new Date() },
    });
    const broken = (await today()).failedWebhooks.find(
      (w: { tenantId: string }) => w.tenantId === owner.tenantId,
    );
    expect(broken).toMatchObject({ failedCount: 1 });
  });

  it('«Hecho hoy» cuenta tickets respondidos, no mensajes', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-done');
    const ticket = await request(app.getHttpServer())
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: 'Duda', body: 'Hola', priority: 'normal' })
      .expect(201);
    const before = (await today()).done.ticketsAnswered;
    for (const body of ['Primera respuesta', 'Y otra más']) {
      await request(app.getHttpServer())
        .post(`/admin/support/tickets/${ticket.body.id}/messages`)
        .set(auth)
        .send({ body, isInternal: false })
        .expect(201);
    }
    expect((await today()).done.ticketsAnswered).toBe(before + 1);
  });

  it('GET /admin/today/count da el número de urgentes', async () => {
    const full = await today();
    const res = await request(app.getHttpServer()).get('/admin/today/count').set(auth).expect(200);
    expect(res.body).toEqual({ urgentCount: full.urgentCount });
    await request(app.getHttpServer()).get('/admin/today/count').expect(401);
  });

  it('recuperar un aviso apartado queda en el registro', async () => {
    const ref = `cron-${Date.now()}`;
    await snooze('cron', ref);
    const row = await db.adminTodaySnooze.findFirstOrThrow({ where: { kind: 'cron', ref } });
    await request(app.getHttpServer())
      .delete(`/admin/today/snoozes/${row.id}`)
      .set(auth)
      .expect(204);
    let log = null;
    for (let i = 0; i < 20 && !log; i++) {
      log = await db.superAdminAuditLog.findFirst({
        where: { action: 'admin.today.unsnoozed', targetId: row.id },
      });
      if (!log) await new Promise((r) => setTimeout(r, 100));
    }
    expect(log).not.toBeNull();
    expect(log?.superAdminId).toBe(adminId);
  });

  it('el aviso inmediato no se repite cada día por lo mismo, solo con novedades', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-watch');
    const ticket = await request(app.getHttpServer())
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: `Alarma sonando ${Date.now()}`, body: 'Hola', priority: 'urgent' })
      .expect(201);
    const id = ticket.body.id as string;
    await db.$executeRaw`UPDATE support_ticket_messages SET created_at = now() - interval '1 hour' WHERE ticket_id = ${id}::uuid`;
    await db.platformAlertSettings.updateMany({ data: { instantAlertsEnabled: true } });
    const watch = app.get(TodayWatchService);
    const mentions = (lines: string[]) => lines.some((l) => l.includes(ticket.body.subject));
    // Pasa un día desde el último aviso de este ticket.
    const dayLater = () =>
      db.$executeRaw`UPDATE security_alert_states SET last_sent_at = now() - interval '25 hours' WHERE kind = 'today' AND identifier = ${`ticket:${id}`}`;

    expect(mentions((await watch.check()).lines)).toBe(true);
    await dayLater();
    expect(mentions((await watch.check()).lines)).toBe(false);

    await request(app.getHttpServer())
      .post(`/support/tickets/${id}/messages`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ body: 'Sigue sonando' })
      .expect(201);
    expect(mentions((await watch.check()).lines)).toBe(true);
    await db.securityAlertState.deleteMany({ where: { kind: 'today' } });
  });

  it('no se cobra el extra de un tenant dado de baja', async () => {
    const owner = await registerVerifiedUser(app, 'today-review-addon');
    const addon = await db.subscriptionAddon.create({
      data: { slug: ADDON_SLUG, name: 'Extra de prueba', priceMonthly: 10, isActive: true },
    });
    const assigned = await db.tenantSubscriptionAddon.create({
      data: {
        tenantId: owner.tenantId,
        addonId: addon.id,
        priceMonthly: 10,
        quantity: 1,
        billingMode: 'manual',
        nextChargeAt: new Date(Date.now() - DAY),
      },
    });
    expect(
      (await today()).addonCharges.some(
        (c: { tenantAddonId: string }) => c.tenantAddonId === assigned.id,
      ),
    ).toBe(true);

    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'cancelled' } });
    expect(
      (await today()).addonCharges.some(
        (c: { tenantAddonId: string }) => c.tenantAddonId === assigned.id,
      ),
    ).toBe(false);
    const res = await request(app.getHttpServer())
      .post(`/admin/today/addon-charges/${assigned.id}/charge`)
      .set(auth)
      .send({ provider: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('addon_not_chargeable');
  });
});
