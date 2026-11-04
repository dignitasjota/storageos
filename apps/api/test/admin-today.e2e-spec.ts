import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-today-test@storageos.local';

/**
 * Bandeja «Hoy» del super admin: los cobros de add-ons pendientes (de tenants
 * que pagan el plan por Stripe) aparecen y se cobran sin extender el periodo.
 */
describe('Admin «Hoy» (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;
  let addonId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Today',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-today-ai' } });
    const addon = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-today-ai', name: 'Asistente IA', priceMonthly: 12, isActive: true },
    });
    addonId = addon.id;
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-today-ai' } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('lista el cobro de add-on pendiente y lo cobra sin extender el periodo', async () => {
    const owner = await registerVerifiedUser(app, 'today-addon');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // El tenant paga el plan por Stripe (condición para el recordatorio de add-on).
    const subBefore = await admin.tenantSubscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: `sub_today_${Date.now()}` },
    });
    const periodEndBefore = subBefore.currentPeriodEnd.getTime();

    // Asignar el add-on → programa su primer cobro para ya.
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    expect(assign.status).toBe(201);

    // Aparece en la bandeja «Hoy».
    const today1 = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today1.status).toBe(200);
    const due = today1.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === tenantId);
    expect(due).toBeTruthy();
    expect(due.amount).toBe(12);
    expect(today1.body.urgentCount).toBeGreaterThanOrEqual(1);

    // Cobrarlo → registra el pago y reprograma el siguiente en un mes.
    const charged = await request(app.getHttpServer())
      .post(`/admin/today/addon-charges/${due.tenantAddonId}/charge`)
      .set(auth)
      .send({ provider: 'cash' });
    expect(charged.status).toBe(201);
    // Ya no está pendiente (next_charge_at movido a +1 mes).
    expect(
      charged.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === tenantId),
    ).toBeUndefined();

    // El pago se registró SIN extender el periodo del plan.
    const subAfter = await admin.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter!.currentPeriodEnd.getTime()).toBe(periodEndBefore);

    const payments = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/saas-payments`)
      .set(auth);
    expect(payments.body.some((p: { amount: number }) => p.amount === 12)).toBe(true);
  });

  it('los extras de un tenant domiciliado por SEPA no salen para cobrar aparte', async () => {
    const owner = await registerVerifiedUser(app, 'today-sepa-addon');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { billingMode: 'sepa' },
    });
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    expect(assign.status).toBe(201);

    const today = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today.status).toBe(200);
    expect(
      today.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === tenant.id),
    ).toBeUndefined();
  });

  it('lista renovaciones manuales por expirar y add-ons suspendidos hace tiempo', async () => {
    const owner = await registerVerifiedUser(app, 'today-renew');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Suscripción de pago manual (sin Stripe) que vence en 3 días.
    const in3d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    await admin.tenantSubscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: null, status: 'active', currentPeriodEnd: in3d },
    });

    // Add-on suspendido hace 40 días.
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    const assignmentId = assigned.body.addons[0].id as string;
    await admin.tenantSubscriptionAddon.update({
      where: { id: assignmentId },
      data: { suspendedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
    });

    const today = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today.status).toBe(200);
    const renewal = today.body.manualRenewalsDue.find(
      (r: { tenantId: string }) => r.tenantId === tenantId,
    );
    expect(renewal).toBeTruthy();
    expect(renewal.daysLeft).toBeGreaterThanOrEqual(2);
    expect(renewal.daysLeft).toBeLessThanOrEqual(3);

    const stale = today.body.staleSuspendedAddons.find(
      (s: { tenantId: string }) => s.tenantId === tenantId,
    );
    expect(stale).toBeTruthy();
    expect(stale.daysSuspended).toBeGreaterThanOrEqual(39);

    // Triaje añadido: tickets sin responder + jobs de colas fallidos.
    expect(Array.isArray(today.body.openTickets)).toBe(true);
    expect(typeof today.body.failedJobs).toBe('number');

    // Una cuenta EXENTA no debe salir como renovación manual pendiente aunque su
    // periodo venza (no se cobra nunca).
    await admin.tenant.update({ where: { id: tenantId }, data: { billingExempt: true } });
    const afterExempt = await request(app.getHttpServer()).get('/admin/today').set(auth);
    const stillThere = afterExempt.body.manualRenewalsDue.find(
      (r: { tenantId: string }) => r.tenantId === tenantId,
    );
    expect(stillThere).toBeUndefined();
  });

  it('lista los tenants con entregas de webhook fallidas en los últimos 7 días', async () => {
    const owner = await registerVerifiedUser(app, 'today-webhooks');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    const webhook = await admin.webhook.create({
      data: {
        tenantId,
        name: 'ERP',
        url: 'https://example.com/hook',
        secret: 'enc',
        events: ['invoice.paid'],
      },
    });
    const base = {
      tenantId,
      webhookId: webhook.id,
      eventType: 'invoice.paid',
      payload: {},
      signature: 'x',
      scheduledFor: new Date(),
    };
    await admin.webhookDelivery.createMany({
      data: [
        { ...base, status: 'failed', statusCode: 500, attempts: 3 },
        { ...base, status: 'failed', errorMessage: 'timeout', attempts: 3 },
        { ...base, status: 'delivered', statusCode: 200, attempts: 1 },
        // Fallida pero antigua (>7 días) → no cuenta.
        {
          ...base,
          status: 'failed',
          attempts: 3,
          createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
        },
      ],
    });

    const today = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today.status).toBe(200);
    const row = today.body.failedWebhooks.find(
      (w: { tenantId: string }) => w.tenantId === tenantId,
    );
    expect(row).toMatchObject({ tenantName: tenant!.name, failedCount: 2 });
    expect(typeof row.lastFailedAt).toBe('string');
  });

  it('solo cuenta los seguimientos que tocan hoy y la espera del ticket desde el último mensaje del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'today-followups');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const madrid = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
    const today = madrid(new Date());
    const future = madrid(new Date(Date.now() + 10 * 86_400_000));
    await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({ title: 'Llamar hoy', dueDate: today })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({ title: 'Llamar dentro de 10 días', dueDate: future })
      .expect(201);

    const ticket = await request(app.getHttpServer())
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: 'Duda con una factura', body: 'Hola', priority: 'normal' })
      .expect(201);
    // Abierto hace 5 días, último mensaje del tenant hace 2 y un cambio de
    // hoy (p. ej. de prioridad): espera 2 días, no 0 ni 5.
    const ticketId = ticket.body.id as string;
    await admin.$executeRaw`UPDATE support_tickets SET created_at = now() - interval '5 days', updated_at = now() WHERE id = ${ticketId}::uuid`;
    await admin.$executeRaw`UPDATE support_ticket_messages SET created_at = now() - interval '2 days' WHERE ticket_id = ${ticketId}::uuid`;

    const res = await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200);
    const mine = (res.body.followupsDue as Array<{ tenantId: string; title: string }>).filter(
      (f) => f.tenantId === owner.tenantId,
    );
    expect(mine.map((f) => f.title)).toEqual(['Llamar hoy']);
    const t = (res.body.openTickets as Array<{ id: string; waitingDays: number }>).find(
      (x) => x.id === ticketId,
    );
    expect(t?.waitingDays).toBe(2);
  });

  it('un extra que dejó de cobrarse a mano no se cobra dos veces, y el cobro queda auditado', async () => {
    const owner = await registerVerifiedUser(app, 'today-charge-guard');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    expect(assign.status).toBe(201);
    const row = await admin.tenantSubscriptionAddon.findFirstOrThrow({
      where: { tenantId: tenant.id },
    });
    // Tocaba hace 10 días: el siguiente cuenta desde esa fecha, no desde hoy.
    const due = new Date(Date.now() - 10 * 86_400_000);
    await admin.tenantSubscriptionAddon.update({
      where: { id: row.id },
      data: { nextChargeAt: due },
    });
    const url = `/admin/today/addon-charges/${row.id}/charge`;

    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { billingMode: 'sepa' },
    });
    const sepa = await request(app.getHttpServer()).post(url).set(auth).send({ provider: 'cash' });
    expect(sepa.status).toBe(409);
    expect(sepa.body.code).toBe('addon_not_chargeable');
    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { billingMode: 'manual' },
    });

    await request(app.getHttpServer())
      .post(url)
      .set(auth)
      .send({ provider: 'bank_transfer' })
      .expect(201);
    const after = await admin.tenantSubscriptionAddon.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.nextChargeAt!.getTime()).toBeLessThan(Date.now() + 25 * 86_400_000);

    const again = await request(app.getHttpServer()).post(url).set(auth).send({ provider: 'cash' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('addon_already_charged');

    const log = await admin.superAdminAuditLog.findFirst({
      where: { action: 'admin.saas_addon.charged', targetTenantId: tenant.id },
    });
    expect(log?.changes).toMatchObject({ provider: 'bank_transfer' });
  });

  it('solo pide renovar a mano lo que de verdad se cobra a mano', async () => {
    const owner = await registerVerifiedUser(app, 'today-renewal-mode');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await admin.tenant.update({
      where: { id: tenant.id },
      data: { status: 'active', trialEndsAt: null },
    });
    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: 'active',
        billingMode: 'manual',
        currentPeriodEnd: new Date(Date.now() + 2 * 86_400_000),
      },
    });
    const listed = async (): Promise<boolean> => {
      const res = await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200);
      return res.body.manualRenewalsDue.some((r: { tenantId: string }) => r.tenantId === tenant.id);
    };
    expect(await listed()).toBe(true);

    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { billingMode: 'redsys' },
    });
    expect(await listed()).toBe(false);

    const free = await admin.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'free' } });
    await admin.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { billingMode: 'manual', planId: free.id },
    });
    expect(await listed()).toBe(false);
  });

  it('la cifra de pendiente es la misma que la de Cobros pendientes', async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const today = await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200);
    const receivables = await request(app.getHttpServer())
      .get('/admin/billing/receivables')
      .set(auth)
      .expect(200);
    expect(today.body.kpis.pending).toBe(receivables.body.total);
  });

  it('un ticket en curso al que contesta el tenant vuelve a salir sin responder', async () => {
    const owner = await registerVerifiedUser(app, 'today-ticket-progress');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const created = await request(app.getHttpServer())
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({
        subject: 'Duda sobre la factura',
        category: 'billing',
        body: 'No me cuadra el total',
      });
    expect(created.status).toBe(201);
    await admin.supportTicket.update({
      where: { id: created.body.id },
      data: { status: 'in_progress' },
    });
    const hidden = await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200);
    expect(hidden.body.openTickets.some((t: { id: string }) => t.id === created.body.id)).toBe(
      false,
    );

    await request(app.getHttpServer())
      .post(`/support/tickets/${created.body.id}/messages`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ body: 'Sigo esperando' })
      .expect(201);
    const back = await request(app.getHttpServer()).get('/admin/today').set(auth).expect(200);
    expect(back.body.openTickets.some((t: { id: string }) => t.id === created.body.id)).toBe(true);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/today').expect(401);
  });
});
