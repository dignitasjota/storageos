import { hash as argonHash } from '@node-rs/argon2';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { PaymentRetryService } from '../src/modules/payments/payment-retry.service';
import { JOB_DUNNING_EXECUTE_ACTION } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { PLATFORM_CREDITOR_ADDRESS, platformMandateBody } from './helpers/platform-sepa';
import { cleanupSuperAdmins, SUPER_ADMIN_TEST_PREFIX } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Configuración → Cobros, Escalado de impagos y Suscripción:
 * mandato SEPA en prueba, planes del tenant, periodicidad, pasarelas apagadas,
 * recargo a 0, orden del escalado, domiciliación del portal y auditoría.
 */
describe('Configuración: cobros, escalado y suscripción (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    // Los planes que crea esta suite (no los borra la limpieza de tenants).
    await admin.subscriptionPlan.deleteMany({
      where: {
        OR: [{ slug: { startsWith: 'hidden-e2e-' } }, { slug: { startsWith: 'offered-e2e-' } }],
      },
    });
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('mandato firmado en la prueba: se puede cancelar y la cuota vuelve al pago manual', async () => {
    // Acreedor de la plataforma configurado (lo hace el super admin).
    // Con la conexión de la app (no abre otra a la base de datos).
    const saEmail = `${SUPER_ADMIN_TEST_PREFIX}cfgpay-${Date.now().toString(36)}@storageos.local`;
    await admin.superAdmin.create({
      data: {
        email: saEmail,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Test cfgpay',
        role: 'superadmin',
      },
    });
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: saEmail, password: 'AdminTest!23' });
    expect([200, 201]).toContain(login.status);
    await http()
      .put('/admin/platform-sepa/settings')
      .set({ Authorization: `Bearer ${login.body.accessToken as string}` })
      .send({
        creditorName: 'TrasterOS SL',
        ...PLATFORM_CREDITOR_ADDRESS,
        creditorId: 'ES98ZZZ12345678',
        creditorIban: 'ES9121000418450200051332',
        enabled: true,
      })
      .expect(200);

    const owner = await registerVerifiedUser(app, 'cfgpaymandate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send(platformMandateBody('ES9121000418450200051332'))
      .expect(200);
    const sub = await http().get('/settings/saas-billing').set(auth).expect(200);
    expect(sub.body.billingMode).toBe('sepa');
    expect(sub.body.billingCycle).toBeNull();

    const cancel = await http().delete('/settings/saas-billing/sepa-mandate').set(auth);
    expect(cancel.status).toBe(204);
    const after = await http().get('/settings/saas-billing').set(auth).expect(200);
    expect(after.body.billingMode).toBe('manual');
    const mandate = await http().get('/settings/saas-billing/sepa-mandate').set(auth);
    expect(mandate.body.mandate).toBeNull();

    // Ya domiciliado con un adeudo: no se puede cancelar.
    await http()
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send(platformMandateBody('ES9121000418450200051332'))
      .expect(200);
    await admin.platformSepaMandate.updateMany({
      where: { tenantId: owner.tenantId, status: 'active' },
      data: { sequenceType: 'RCUR', lastCollectedAt: new Date() },
    });
    const blocked = await http().delete('/settings/saas-billing/sepa-mandate').set(auth);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('mode_requires_mandate');
  });

  it('planes del tenant: incluye su plan oculto y el de una propuesta abierta', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpayplans');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const stamp = Date.now().toString(36);
    const hidden = await admin.subscriptionPlan.create({
      data: {
        name: 'Oculto e2e',
        slug: `hidden-e2e-${stamp}`,
        priceMonthly: 70,
        priceYearly: 700,
        isPublic: false,
      },
    });
    const offered = await admin.subscriptionPlan.create({
      data: {
        name: 'Propuesto e2e',
        slug: `offered-e2e-${stamp}`,
        priceMonthly: 90,
        priceYearly: 900,
        isPublic: false,
      },
    });
    try {
      await admin.tenantSubscription.update({
        where: { tenantId: owner.tenantId },
        data: { planId: hidden.id },
      });
      await admin.platformQuoteOffer.create({
        data: { tenantId: owner.tenantId, planId: offered.id, cycle: 'monthly', total: 90 },
      });
      const plans = await http().get('/settings/saas-billing/plans').set(auth).expect(200);
      const ids = (plans.body as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(hidden.id);
      expect(ids).toContain(offered.id);
      // El catálogo público no los enseña.
      const pub = await http().get('/subscription-plans').expect(200);
      expect((pub.body as { id: string }[]).map((p) => p.id)).not.toContain(hidden.id);
    } finally {
      const starter = await admin.subscriptionPlan.findUniqueOrThrow({
        where: { slug: 'starter' },
      });
      await admin.tenantSubscription.updateMany({
        where: { tenantId: owner.tenantId },
        data: { planId: starter.id },
      });
      await admin.platformQuoteOffer.deleteMany({ where: { tenantId: owner.tenantId } });
      await admin.subscriptionPlan.deleteMany({ where: { id: { in: [hidden.id, offered.id] } } });
    }
  });

  it('pasarela apagada: no se cobra, ni se avisa al inquilino ni se gasta el reintento', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpaygw');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ autoChargeOnIssue: true, autoChargeRetryEnabled: true })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await admin.invoice.update({ where: { id: invoiceId }, data: { status: 'overdue' } });
    // Domiciliación de GoCardless guardada, pero GoCardless está apagado.
    const pm = await admin.paymentMethod.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        type: 'sepa_debit',
        gateway: 'gocardless',
        gatewayTokenEncrypted: 'MD_test',
        isDefault: true,
      },
    });

    const noPm = await http().post(`/payments/invoices/${invoiceId}/charge`).set(auth).send({});
    expect(noPm.status).toBe(400);
    expect(noPm.body.code).toBe('no_payment_method');
    const explicit = await http()
      .post(`/payments/invoices/${invoiceId}/charge`)
      .set(auth)
      .send({ paymentMethodId: pm.id });
    expect(explicit.status).toBe(400);
    expect(explicit.body.code).toBe('payment_gateway_disabled');

    await app.get(PaymentRetryService).runRetries();
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.autoRetryCount).toBe(0);
    expect(await admin.payment.count({ where: { invoiceId } })).toBe(0);
  });

  it('escalado: recargo activado a 0 y pasos fuera de orden no se guardan', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpaydun');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const base = (await http().get('/dunning/settings').set(auth).expect(200)).body as Record<
      string,
      unknown
    >;
    const input = {
      firstReminderDays: base.firstReminderDays,
      secondReminderDays: base.secondReminderDays,
      lateFeeEnabled: base.lateFeeEnabled,
      lateFeeType: base.lateFeeType,
      lateFeeValue: base.lateFeeValue,
      lateFeeGraceDays: base.lateFeeGraceDays,
      accessCutMode: base.accessCutMode,
      accessCutDays: base.accessCutDays,
      legalNoticeDays: base.legalNoticeDays,
    };
    const zero = await http()
      .put('/dunning/settings')
      .set(auth)
      .send({ ...input, lateFeeEnabled: true, lateFeeValue: 0 });
    expect(zero.status).toBe(400);
    expect(JSON.stringify(zero.body)).toContain('mayor que 0');

    const cutTooSoon = await http()
      .put('/dunning/settings')
      .set(auth)
      .send({
        ...input,
        firstReminderDays: 3,
        secondReminderDays: 10,
        accessCutMode: 'all',
        accessCutDays: 5,
      });
    expect(cutTooSoon.status).toBe(400);
    expect(JSON.stringify(cutTooSoon.body)).toContain('corte del acceso');

    const ok = await http()
      .put('/dunning/settings')
      .set(auth)
      .send({
        ...input,
        firstReminderDays: 3,
        secondReminderDays: 10,
        accessCutMode: 'all',
        accessCutDays: 14,
        legalNoticeDays: 30,
        lateFeeEnabled: true,
        lateFeeType: 'percentage',
        lateFeeValue: 5,
      });
    expect(ok.status).toBe(200);
  });

  it('un recargo configurado a 0 se salta (no se reprograma cada día)', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpayfee');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await admin.invoice.update({ where: { id: invoiceId }, data: { status: 'overdue' } });
    // Configuración antigua, anterior a la validación: activado con 0.
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { lateFeeEnabled: true, lateFeeType: 'fixed', lateFeeValue: 0 },
    });
    const action = await admin.dunningAction.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        actionType: 'late_fee',
        scheduledFor: new Date(),
      },
    });
    await app
      .get(DunningService)
      .handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId: owner.tenantId, actionId: action.id });
    const after = await admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.status).toBe('executed');
    expect(after.result).toMatchObject({ lateFeeSkipped: 'zero_amount' });
  });

  it('domiciliación del portal: exige el domicilio completo y se apaga con las remesas', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpaysepa');
    // Con la conexión de la app (no abre otra a la base de datos).
    const pro = await admin.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'pro' } });
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: pro.id },
    });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const sepa = {
      creditorName: 'Trasteros SL',
      creditorId: 'ES97ZZZB12345678',
      creditorIban: 'ES9121000418450200051332',
      creditorBic: '',
      prenoticeDays: 14,
      enabled: true,
      creditorAddress: 'Calle Mayor 1',
      creditorPostalCode: '',
      creditorCity: 'Madrid',
    };
    await http().put('/sepa/settings').set(auth).send(sepa).expect(200);
    const incomplete = await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ offlineSepaEnabled: true });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('sepa_not_enabled');

    const { creditorIban: _iban, ...withoutIban } = sepa;
    await http()
      .put('/sepa/settings')
      .set(auth)
      .send({ ...withoutIban, creditorPostalCode: '28001' })
      .expect(200);
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ offlineSepaEnabled: true })
      .expect(200);

    await http()
      .put('/sepa/settings')
      .set(auth)
      .send({ ...withoutIban, creditorPostalCode: '28001', enabled: false })
      .expect(200);
    const billing = await http().get('/settings/tenant/billing').set(auth).expect(200);
    expect(billing.body.offlineSepaEnabled).toBe(false);

    // El cambio del acreedor queda en el registro, sin el IBAN.
    const log = await admin.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'settings.sepa_creditor_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(log).not.toBeNull();
    expect(JSON.stringify(log?.changes)).not.toContain('ES9121000418450200051332');
  });

  it('Redsys y GoCardless: cambios auditados sin secretos y dirección del webhook', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpaygc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7',
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const redsysLog = await admin.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'settings.redsys_changed' },
    });
    expect(redsysLog?.changes).toMatchObject({ secretsChanged: ['secretKey'] });
    expect(JSON.stringify(redsysLog?.changes)).not.toContain('sq7HjrUOBfKmC576');

    const gc = await http().get('/settings/gocardless').set(auth).expect(200);
    expect(gc.body.webhookUrl).toMatch(new RegExp(`/webhooks/gocardless/${owner.tenantId}$`));
    await http()
      .put('/settings/gocardless')
      .set(auth)
      .send({ environment: 'sandbox', enabled: false, accessToken: 'tok_e2e_123456789' })
      .expect(200);
    const gcLog = await admin.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'settings.gocardless_changed' },
    });
    expect(JSON.stringify(gcLog?.changes)).not.toContain('tok_e2e_123456789');
  });
});
