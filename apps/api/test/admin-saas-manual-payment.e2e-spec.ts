import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';
import { PlatformDunningService } from '../src/modules/billing-saas/platform-dunning.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-smp-test@storageos.local';

describe('Admin SaaS manual payment (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin SMP Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('registra un pago manual, extiende el periodo y soporta descuento', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp');

    const before = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    const periodEndBefore = new Date(before.body.subscription.currentPeriodEnd).getTime();

    // Pago manual por transferencia, 2 meses
    const created = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 58, durationMonths: 2 });
    expect(created.status).toBe(201);
    expect(created.body.provider).toBe('bank_transfer');
    expect(created.body.status).toBe('paid');
    expect(created.body.amount).toBe(58);
    const newPeriodEnd = new Date(created.body.periodEnd).getTime();
    expect(newPeriodEnd).toBeGreaterThan(periodEndBefore);

    // El detalle del tenant refleja el periodo extendido + status active
    const after = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(new Date(after.body.subscription.currentPeriodEnd).getTime()).toBe(newPeriodEnd);
    expect(after.body.subscription.status).toBe('active');

    // Aparece en el historial
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/saas-payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].provider).toBe('bank_transfer');
    expect(list.body[0].discount).toBeNull();

    // Segundo pago en efectivo con descuento, 1 mes → extiende desde el nuevo fin
    const withDiscount = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 20, discount: 9, durationMonths: 1 });
    expect(withDiscount.status).toBe(201);
    expect(withDiscount.body.discount).toBe(9);
    expect(new Date(withDiscount.body.periodEnd).getTime()).toBeGreaterThan(newPeriodEnd);

    // Validación: importe negativo -> 400
    const bad = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'other', amount: -5, durationMonths: 1 });
    expect(bad.status).toBe(400);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .send({ provider: 'cash', amount: 10, durationMonths: 1 });
    expect(noAuth.status).toBe(401);
  });

  it('es idempotente ante doble submit: dos pagos idénticos en <60s no duplican', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-idem');
    const before = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    const periodEndBefore = new Date(before.body.subscription.currentPeriodEnd).getTime();

    const p1 = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 99, durationMonths: 3 });
    expect(p1.status).toBe(201);
    // Doble clic: mismo provider + importe → devuelve el mismo pago, no duplica.
    const p2 = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 99, durationMonths: 3 });
    expect(p2.status).toBe(201);
    expect(p2.body.id).toBe(p1.body.id);

    // Solo un pago en el historial.
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/saas-payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);

    // El periodo se extendió UNA sola vez (no el doble).
    const after = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    const periodEnd = new Date(after.body.subscription.currentPeriodEnd).getTime();
    expect(periodEnd).toBe(new Date(p1.body.periodEnd).getTime());
    expect(periodEnd).toBeGreaterThan(periodEndBefore);
  });

  it('el crédito manual se SUMA al periodo de Stripe (acumulador permanente)', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-acc');

    // El acumulador solo aplica a tenants que YA pagan por Stripe (para que el
    // webhook sume el crédito por encima); se lo vinculamos antes del pago manual.
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeSubscriptionId: `sub_acc_pre_${Date.now()}` },
    });

    // Pago manual de 1 mes → acumula sus días en manual_extension_days
    const manual = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 29, durationMonths: 1 });
    expect(manual.status).toBe(201);

    const sub = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const manualDays = sub?.manualExtensionDays ?? 0;
    expect(manualDays).toBeGreaterThanOrEqual(28);

    // Simula un webhook de Stripe que fija el periodo a "ahora + 90 días".
    const svc = app.get(BillingSaasService, { strict: false });
    const nowSec = Math.floor(Date.now() / 1000);
    const stripeEndSec = nowSec + 90 * 24 * 3600;
    await svc.syncSubscriptionFromStripe({
      stripeSubscriptionId: `sub_acc_${Date.now()}`,
      stripeCustomerId: `cus_acc_${Date.now()}`,
      tenantIdHint: owner.tenantId,
      status: 'active',
      currentPeriodStart: nowSec,
      currentPeriodEnd: stripeEndSec,
      cancelAtPeriodEnd: false,
    });

    // El periodo efectivo = fecha de Stripe + los días manuales (no se pisa).
    const after = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const expectedEndMs = stripeEndSec * 1000 + manualDays * 24 * 3600 * 1000;
    expect(Math.abs((after?.currentPeriodEnd.getTime() ?? 0) - expectedEndMs)).toBeLessThan(1000);
    // El acumulador no se toca en el webhook (crédito permanente).
    expect(after?.manualExtensionDays).toBe(manualDays);
  });

  it('un cobro con extendsPeriod=false NO toca el periodo ni el acumulador', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-noext');

    const before = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const periodEndBefore = before!.currentPeriodEnd.getTime();
    const manualDaysBefore = before!.manualExtensionDays;

    // Cobro puntual de un add-on (15 €), sin extender el periodo.
    const created = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 15, durationMonths: 1, extendsPeriod: false });
    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(15);

    // El pago se registra (sale en el historial)…
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/saas-payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);

    // …pero el periodo y el acumulador NO cambian.
    const after = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(after!.currentPeriodEnd.getTime()).toBe(periodEndBefore);
    expect(after!.manualExtensionDays).toBe(manualDaysBefore);
  });

  it('un pago de suscripción a un tenant en TRIAL lo pasa a active', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-trial');
    // Aseguramos que arranca en trial.
    await adminClient.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'trial' },
    });

    const pay = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 49, durationMonths: 1 });
    expect(pay.status).toBe(201);

    // Al pagar la suscripción, el tenant deja de ser trial → active.
    const tenant = await adminClient.tenant.findUnique({ where: { id: owner.tenantId } });
    expect(tenant!.status).toBe('active');
  });

  it('enforcement manual: periodo vencido → past_due + banner; el pago cuenta desde la fecha debida', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-enf');

    // Simula un tenant de pago manual (sin Stripe) cuyo periodo venció hace 10 días.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'active',
        stripeSubscriptionId: null,
        currentPeriodStart: new Date(Date.now() - 40 * 24 * 3600 * 1000),
        currentPeriodEnd: tenDaysAgo,
      },
    });
    await adminClient.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });

    // El enforcement lo marca past_due.
    const dunning = app.get(PlatformDunningService, { strict: false });
    const flagged = await dunning.markLapsedManualPastDue();
    expect(flagged).toBeGreaterThanOrEqual(1);

    const sub1 = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(sub1!.status).toBe('past_due');

    // El tenant ve el banner (billing-status: pastDue + planManual, sin Stripe).
    const status = await request(app.getHttpServer())
      .get('/settings/billing-status')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(status.status).toBe(200);
    expect(status.body.pastDue).toBe(true);
    expect(status.body.planManual).toBe(true);
    expect(status.body.hasIssue).toBe(true);

    // Paga 1 mes: el nuevo periodo cuenta desde la fecha DEBIDA (hace 10 días),
    // no desde hoy → fin ≈ hoy+20d, y como cubre "ahora" vuelve a active.
    const pay = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 79, durationMonths: 1 });
    expect(pay.status).toBe(201);

    const sub2 = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(sub2!.status).toBe('active');
    const newEndMs = sub2!.currentPeriodEnd.getTime();
    // Contado desde la fecha debida (−10d): fin ≈ hoy+20d. Si contara desde hoy
    // sería hoy+30d → nuestro fin es claramente menor que hoy+27d.
    expect(newEndMs).toBeGreaterThan(Date.now()); // cubre "ahora" (active)
    expect(newEndMs).toBeLessThan(Date.now() + 27 * 24 * 3600 * 1000);
  });

  it('pasa un tenant de Stripe a pago manual: desvincula + conserva el periodo', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-switch');

    // Simula un tenant que hoy paga por Stripe.
    const periodEnd = new Date(Date.now() + 20 * 24 * 3600 * 1000);
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'active',
        stripeSubscriptionId: `sub_switch_${Date.now()}`,
        stripeCustomerId: `cus_switch_${Date.now()}`,
        currentPeriodEnd: periodEnd,
        manualExtensionDays: 15,
      },
    });

    // Pasar a pago manual (la cancelación en Stripe es best-effort: con clave
    // dummy falla silenciosa, pero la desvinculación se aplica igual).
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/switch-to-manual`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const sub = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(sub!.stripeSubscriptionId).toBeNull();
    expect(sub!.stripeCustomerId).toBeNull();
    expect(sub!.status).toBe('active');
    expect(sub!.manualExtensionDays).toBe(0); // reset (el crédito ya está en el periodo)
    // Conserva el periodo ya pagado.
    expect(sub!.currentPeriodEnd.getTime()).toBe(periodEnd.getTime());

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/switch-to-manual`)
      .send();
    expect(noAuth.status).toBe(401);
  });

  it('enforcement manual: un pago parcial que no cubre "ahora" sigue past_due', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-partial');

    // Periodo vencido hace 40 días.
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        stripeSubscriptionId: null,
        currentPeriodStart: new Date(Date.now() - 70 * 24 * 3600 * 1000),
        currentPeriodEnd: new Date(Date.now() - 40 * 24 * 3600 * 1000),
      },
    });

    // Paga 1 mes: −40d + 1mes ≈ −10d (aún en el pasado) → sigue past_due.
    const pay = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 79, durationMonths: 1 });
    expect(pay.status).toBe(201);

    const sub = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(sub!.status).toBe('past_due');
    expect(sub!.currentPeriodEnd.getTime()).toBeLessThan(Date.now());
  });
});
