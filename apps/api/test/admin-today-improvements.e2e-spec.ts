import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminTodayService } from '../src/modules/admin/admin-today.service';

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
const HOUR = 3_600_000;
const LEAD_EMAIL_DOMAIN = '@today-improvements.e2e.local';

interface Lead {
  id: string;
  assignedToId: string | null;
}

describe('Mejoras de «Hoy» del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let supportAuth: { Authorization: string };
  let adminId: string;

  const server = () => app.getHttpServer();
  const today = async () =>
    (await request(server()).get('/admin/today?fresh=1').set(auth).expect(200)).body;
  const lead = (name: string, data: Record<string, unknown> = {}) =>
    db.platformLead.create({
      data: {
        contactName: name,
        email: `${name.toLowerCase().replace(/\s+/g, '-')}${LEAD_EMAIL_DOMAIN}`,
        source: 'web_contact',
        ...data,
      },
    });
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/admin/auth/login').send({ email, password });
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await db.adminTodaySnooze.deleteMany({});
    await db.adminReviewedJob.deleteMany({});
    await db.platformLead.deleteMany({ where: { email: { endsWith: LEAD_EMAIL_DOMAIN } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('today-improve');
    adminId = admin.id;
    auth = await login(admin.email, admin.password);
    const support = await seedSuperAdmin('today-improve-support');
    await db.superAdmin.update({ where: { id: support.id }, data: { role: 'support' } });
    supportAuth = await login(support.email, support.password);
  });

  afterAll(async () => {
    await db.adminTodaySnooze.deleteMany({});
    await db.adminReviewedJob.deleteMany({});
    await db.platformLead.deleteMany({ where: { email: { endsWith: LEAD_EMAIL_DOMAIN } } });
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    await db.$disconnect();
  });

  it('separa los leads sin asignar de los asignados sin atender, del más antiguo al más nuevo', async () => {
    const older = await lead('Lead Antiguo', { createdAt: new Date(Date.now() - 5 * HOUR) });
    const newer = await lead('Lead Nuevo');
    const fresh = await lead('Lead Asignado Hoy', { assignedToId: adminId });
    const stale = await lead('Lead Asignado Ayer', {
      assignedToId: adminId,
      createdAt: new Date(Date.now() - 30 * HOUR),
    });

    const body = await today();
    const unassigned = body.newLeads.map((l: Lead) => l.id);
    expect(unassigned.indexOf(older.id)).toBeGreaterThanOrEqual(0);
    expect(unassigned.indexOf(older.id)).toBeLessThan(unassigned.indexOf(newer.id));
    expect(unassigned).not.toContain(fresh.id);
    const assigned = body.assignedLeads.map((l: Lead) => l.id);
    expect(assigned).toContain(stale.id);
    expect(assigned).not.toContain(fresh.id);

    // El asignado sin atender no es urgente para el resto del equipo.
    const before = body.urgentCount;
    await db.platformLead.update({ where: { id: stale.id }, data: { assignedToId: null } });
    expect((await today()).urgentCount).toBe(before + 1);
    await db.platformLead.deleteMany({
      where: { id: { in: [older.id, newer.id, fresh.id, stale.id] } },
    });
  });

  it('los tickets llevan su plazo, salen por lo que vence antes y solo urgen si vencen ya', async () => {
    const owner = await registerVerifiedUser(app, 'today-improve-tickets');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const open = async (subject: string, priority: string) =>
      (
        await request(server())
          .post('/support/tickets')
          .set(tenantAuth)
          .send({ subject, body: 'Hola', priority })
          .expect(201)
      ).body.id as string;

    const before = await today();
    const fresh = await open('Una duda sin prisa', 'low');
    const afterFresh = await today();
    const freshRow = afterFresh.openTickets.find((t: { id: string }) => t.id === fresh);
    expect(freshRow.responseTargetHours).toBe(Math.round(afterFresh.responseTargets.low * 10) / 10);
    expect(freshRow.dueInHours).toBeGreaterThan(0);
    if (afterFresh.responseTargets.low > 2) {
      // Sale, pero aún no es urgente.
      expect(afterFresh.urgentCount).toBe(before.urgentCount);
    }

    const late = await open('Lleva días esperando', 'low');
    await db.$executeRaw`UPDATE support_tickets SET created_at = now() - interval '20 days' WHERE id = ${late}::uuid`;
    await db.$executeRaw`UPDATE support_ticket_messages SET created_at = now() - interval '20 days' WHERE ticket_id = ${late}::uuid`;
    const body = await today();
    const ids = body.openTickets.map((t: { id: string }) => t.id);
    expect(ids.indexOf(late)).toBeLessThan(ids.indexOf(fresh));
    const lateRow = body.openTickets.find((t: { id: string }) => t.id === late);
    expect(lateRow.dueInHours).toBeLessThan(0);
    expect(body.urgentCount).toBe(afterFresh.urgentCount + 1);
    expect(Object.keys(body.responseTargets).sort()).toEqual(['high', 'low', 'normal', 'urgent']);
  });

  it('las pruebas salen por lo que les queda y, a igualdad, por lo que se usan', async () => {
    const quiet = await registerVerifiedUser(app, 'today-improve-trial-a');
    const busy = await registerVerifiedUser(app, 'today-improve-trial-b');
    const ends = new Date(Date.now() + 2 * DAY);
    await db.tenant.updateMany({
      where: { id: { in: [quiet.tenantId, busy.tenantId] } },
      data: { status: 'trial', trialEndsAt: ends, billingExempt: false },
    });
    await db.facility.create({
      data: { tenantId: busy.tenantId, name: 'Local', address: 'Calle 1', city: 'Madrid' },
    });
    const body = await today();
    const ids = body.trialsExpiring.map((t: { id: string }) => t.id);
    expect(ids.indexOf(busy.tenantId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(busy.tenantId)).toBeLessThan(ids.indexOf(quiet.tenantId));
    // La cuota de las pruebas que terminan en ≤3 días cuenta en el dinero en juego.
    const m = body.moneyAtRisk;
    expect(m.total).toBeCloseTo(m.pastDue + m.trialsEnding + m.addonCharges + m.inactive, 2);
  });

  it('reintenta y marca revisados los fallidos de las colas (solo superadmin)', async () => {
    const queues = (app.get(AdminTodayService) as unknown as { queues: Queue[] }).queues;
    const queue = queues[0]!;
    const failedAt = Date.now() - HOUR;
    const retry = jest.fn().mockResolvedValue(undefined);
    const job = {
      id: 'job-e2e-1',
      name: 'enviar-correo',
      failedReason: 'SMTP caído\n    at linea 1',
      attemptsMade: 3,
      finishedOn: failedAt,
      isFailed: async () => true,
      retry,
    } as unknown as Job;
    const spies = [
      ...queues.map((q, i) => jest.spyOn(q, 'getFailed').mockResolvedValue(i === 0 ? [job] : [])),
      jest.spyOn(queue, 'getJob').mockResolvedValue(job),
    ];
    try {
      const body = await today();
      expect(body.failedJobs).toBe(1);
      expect(body.failedJobsList[0]).toMatchObject({
        queue: queue.name,
        id: 'job-e2e-1',
        name: 'enviar-correo',
        reason: 'SMTP caído',
        attempts: 3,
      });

      const jobs = { jobs: [{ queue: queue.name, id: 'job-e2e-1' }] };
      await request(server())
        .post('/admin/today/failed-jobs/retry')
        .set(supportAuth)
        .send(jobs)
        .expect(403);
      await request(server())
        .post('/admin/today/failed-jobs/review')
        .set(supportAuth)
        .send(jobs)
        .expect(403);

      const retried = await request(server())
        .post('/admin/today/failed-jobs/retry')
        .set(auth)
        .send(jobs)
        .expect(200);
      expect(retried.body).toEqual({ done: 1, failed: [] });
      expect(retry).toHaveBeenCalledTimes(1);

      const reviewed = await request(server())
        .post('/admin/today/failed-jobs/review')
        .set(auth)
        .send(jobs)
        .expect(200);
      expect(reviewed.body).toEqual({ done: 1, failed: [] });
      const after = await today();
      expect(after.failedJobs).toBe(0);
      expect(after.failedJobsList).toEqual([]);

      // Vuelve a fallar después: sale otra vez.
      (job as unknown as { finishedOn: number }).finishedOn = Date.now();
      expect((await today()).failedJobs).toBe(1);

      // Una cola que no existe no rompe el resto.
      const missing = await request(server())
        .post('/admin/today/failed-jobs/review')
        .set(auth)
        .send({ jobs: [{ queue: 'no-existe', id: '1' }] })
        .expect(200);
      expect(missing.body.done).toBe(0);
      expect(missing.body.failed).toHaveLength(1);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('acciones en lote: apartar, asignarme y recordar el pago (soporte no recuerda)', async () => {
    const a = await lead('Lote Uno');
    const b = await lead('Lote Dos');
    const items = [
      { kind: 'contact', ref: a.id, label: 'Lote Uno' },
      { kind: 'contact', ref: b.id, label: 'Lote Dos' },
    ];
    // Asignarme (también el rol soporte).
    const assigned = await request(server())
      .post('/admin/today/batch')
      .set(auth)
      .send({ action: 'assign', items })
      .expect(200);
    expect(assigned.body).toEqual({ done: 2, failed: [] });
    expect(
      (await db.platformLead.findMany({ where: { id: { in: [a.id, b.id] } } })).every(
        (l) => l.assignedToId === adminId,
      ),
    ).toBe(true);
    const notAssignable = await request(server())
      .post('/admin/today/batch')
      .set(auth)
      .send({ action: 'assign', items: [{ kind: 'cron', ref: 'x' }] })
      .expect(200);
    expect(notAssignable.body.failed[0].message).toBe('Solo se pueden asignar tickets y leads');

    // Apartar varios a la vez.
    await db.platformLead.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { assignedToId: null },
    });
    const snoozed = await request(server())
      .post('/admin/today/batch')
      .set(supportAuth)
      .send({ action: 'snooze', days: 7, items })
      .expect(200);
    expect(snoozed.body.done).toBe(2);
    const body = await today();
    expect(body.newLeads.some((l: Lead) => l.id === a.id || l.id === b.id)).toBe(false);
    expect(body.snoozes.filter((s: { ref: string }) => [a.id, b.id].includes(s.ref))).toHaveLength(
      2,
    );
    await request(server())
      .post('/admin/today/batch')
      .set(auth)
      .send({ action: 'snooze', items })
      .expect(400);

    // Recordar el pago: soporte no puede; un impago sí, lo que no debe, no.
    const owner = await registerVerifiedUser(app, 'today-improve-remind');
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        billingMode: 'manual',
        currentPeriodEnd: new Date(Date.now() - 3 * DAY),
      },
    });
    const okTenant = await registerVerifiedUser(app, 'today-improve-paid');
    const remind = {
      action: 'remind',
      items: [
        { kind: 'past_due', ref: owner.tenantId, label: 'Debe' },
        { kind: 'past_due', ref: okTenant.tenantId, label: 'Al día' },
      ],
    };
    await request(server()).post('/admin/today/batch').set(supportAuth).send(remind).expect(403);
    const reminded = await request(server())
      .post('/admin/today/batch')
      .set(auth)
      .send(remind)
      .expect(200);
    expect(reminded.body.done).toBe(1);
    expect(reminded.body.failed).toEqual([
      expect.objectContaining({ ref: okTenant.tenantId, label: 'Al día' }),
    ]);
    await db.platformLead.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it('resumen desde la última visita: nuevo, resuelto y lo que ha empeorado', async () => {
    const gone = await lead('Visita Resuelto');
    const owner = await registerVerifiedUser(app, 'today-improve-visit');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const ticket = (
      await request(server())
        .post('/support/tickets')
        .set(tenantAuth)
        .send({ subject: 'Visita: no funciona', body: 'Hola', priority: 'normal' })
        .expect(201)
    ).body.id as string;
    await db.$executeRaw`UPDATE support_ticket_messages SET created_at = now() - interval '1 hour' WHERE ticket_id = ${ticket}::uuid`;
    await request(server())
      .post('/admin/today/snoozes')
      .set(auth)
      .send({ kind: 'ticket', ref: ticket, label: 'ticket', days: 7 })
      .expect(204);

    // Primera visita: aún no hay con qué comparar.
    const first = await request(server()).post('/admin/today/visit').set(auth).expect(200);
    expect(first.body.show).toBe(false);

    // Pasan unas horas: un lead nuevo, otro resuelto y el ticket vuelve a escribir.
    await db.adminTodayVisit.update({
      where: { superAdminId: adminId },
      data: { seenAt: new Date(Date.now() - 3 * HOUR) },
    });
    const added = await lead('Visita Nuevo');
    await db.platformLead.update({ where: { id: gone.id }, data: { status: 'contacted' } });
    await request(server())
      .post(`/support/tickets/${ticket}/messages`)
      .set(tenantAuth)
      .send({ body: '¿Hay alguien?' })
      .expect(201);

    const second = await request(server()).post('/admin/today/visit').set(auth).expect(200);
    expect(second.body.show).toBe(true);
    const keys = (list: { key: string }[]) => list.map((i) => i.key);
    expect(keys(second.body.newItems)).toContain(`contact:${added.id}`);
    expect(keys(second.body.resolvedItems)).toContain(`contact:${gone.id}`);
    expect(keys(second.body.worseItems)).toContain(`ticket:${ticket}`);
    // El que ha empeorado no cuenta también como nuevo.
    expect(keys(second.body.newItems)).not.toContain(`ticket:${ticket}`);
    expect(second.body.worseItems[0].href).toMatch(/^\/admin\//);

    // Recién vista: el resumen no sale.
    const third = await request(server()).post('/admin/today/visit').set(auth).expect(200);
    expect(third.body.show).toBe(false);
    await db.platformLead.deleteMany({ where: { id: { in: [gone.id, added.id] } } });
  });

  it('cobros de la suscripción rechazados en las últimas 48 h, urgentes, hasta que paga', async () => {
    const owner = await registerVerifiedUser(app, 'today-improve-failure');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { billingExempt: false } });
    const before = await today();
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: owner.tenantId,
        provider: 'stripe',
        externalId: `in_e2e_${owner.tenantId}`,
        status: 'failed',
        amount: 49,
        failedAttempts: 2,
        firstFailedAt: new Date(),
      },
    });
    await db.platformRedsysOrder.create({
      data: {
        order: `e2e${Date.now().toString().slice(-9)}`,
        tenantId: owner.tenantId,
        amountCents: 4900,
        status: 'failed',
        dsResponse: '0190',
        kind: 'auto',
      },
    });
    const body = await today();
    const row = body.paymentFailures.find(
      (p: { tenantId: string }) => p.tenantId === owner.tenantId,
    );
    expect(row).toMatchObject({ amount: 49, failures: 2 });
    expect(['stripe', 'redsys']).toContain(row.source);
    expect(row.reason).toMatch(/rechaza/i);
    expect(body.urgentCount).toBe(before.urgentCount + 1);

    // Paga después del rechazo: deja de salir.
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: owner.tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 49,
        paidAt: new Date(Date.now() + 1000),
      },
    });
    expect(
      (await today()).paymentFailures.some(
        (p: { tenantId: string }) => p.tenantId === owner.tenantId,
      ),
    ).toBe(false);
  });

  it('clientes de pago que han dejado de entrar: con su cuota, no urgentes, y vuelven si empeoran', async () => {
    const owner = await registerVerifiedUser(app, 'today-improve-idle');
    const plan = await db.subscriptionPlan.findFirstOrThrow({
      where: { priceMonthly: { gt: 0 }, isActive: true },
      orderBy: { priceMonthly: 'asc' },
    });
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'active', billingExempt: false, trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'active', planId: plan.id },
    });
    // Su equipo entró ayer: aún no sale.
    await db.user.updateMany({
      where: { tenantId: owner.tenantId },
      data: { lastLoginAt: new Date(Date.now() - DAY) },
    });
    const before = await today();
    expect(
      before.inactivePaying.some((t: { tenantId: string }) => t.tenantId === owner.tenantId),
    ).toBe(false);

    await db.user.updateMany({
      where: { tenantId: owner.tenantId },
      data: { lastLoginAt: new Date(Date.now() - 20 * DAY) },
    });
    const body = await today();
    const row = body.inactivePaying.find(
      (t: { tenantId: string }) => t.tenantId === owner.tenantId,
    );
    expect(row).toMatchObject({ daysSinceLogin: 20 });
    expect(row.monthly).toBeGreaterThanOrEqual(Number(plan.priceMonthly));
    expect(body.urgentCount).toBe(before.urgentCount);
    expect(body.moneyAtRisk.inactive).toBeGreaterThanOrEqual(row.monthly);

    await request(server())
      .post('/admin/today/snoozes')
      .set(auth)
      .send({ kind: 'inactive', ref: owner.tenantId, label: 'idle', days: 30 })
      .expect(204);
    expect(
      (await today()).inactivePaying.some(
        (t: { tenantId: string }) => t.tenantId === owner.tenantId,
      ),
    ).toBe(false);
    // Entró hace 16 días (después de lo apartado) y lo ha vuelto a dejar.
    await db.user.updateMany({
      where: { tenantId: owner.tenantId },
      data: { lastLoginAt: new Date(Date.now() - 16 * DAY) },
    });
    const back = (await today()).inactivePaying.find(
      (t: { tenantId: string }) => t.tenantId === owner.tenantId,
    );
    expect(back).toMatchObject({
      reappeared: true,
      reappearedReason: 'Volvió a entrar y lo ha vuelto a dejar',
    });
  });

  it('las acciones nuevas exigen sesión de super admin', async () => {
    await request(server()).post('/admin/today/visit').expect(401);
    await request(server()).post('/admin/today/batch').send({}).expect(401);
    await request(server()).post('/admin/today/failed-jobs/retry').send({}).expect(401);
  });
});
