import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
} from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Clave de pruebas pública de Redsys (32 caracteres, 24 bytes). */
const REDSYS_TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/**
 * Mejoras de Configuración → Suscripción, Cobros y Escalado de impagos:
 * periodicidad del plan, «Probar TPV» de Redsys, aviso antes de apagar una
 * pasarela y recordatorios del escalado por WhatsApp.
 */
describe('Configuración: suscripción, cobros y escalado (mejoras, e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  it('Suscripción: el mismo plan solo se «cambia» para pasar a anual o mensual', async () => {
    const owner = await registerVerifiedUser(app, 'sicycle');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const sub = await http().get('/settings/saas-billing').set(auth).expect(200);
    const planId = (sub.body as { plan: { id: string } }).plan.id;

    // Sin periodicidad: ya está en ese plan.
    const same = await http()
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId })
      .expect(400);
    expect(same.body.code).toBe('already_on_plan');

    // Sin Stripe, pasar a anual lo hace soporte (y lo dice).
    const yearly = await http()
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId, billingCycle: 'yearly' })
      .expect(400);
    expect(yearly.body.code).toBe('manual_plan_change');
    expect(yearly.body.message).toContain('anual');
  });

  it('Cobros: «Probar TPV» comprueba los datos de Redsys sin guardarlos', async () => {
    const owner = await registerVerifiedUser(app, 'sitpv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const base = { merchantCode: '999008881', terminal: '1', environment: 'test' };

    // Sin clave escrita ni guardada no se puede probar.
    const noKey = await http().post('/settings/redsys/test').set(auth).send(base).expect(400);
    expect(noKey.body.code).toBe('redsys_secret_required');

    const ok = await http()
      .post('/settings/redsys/test')
      .set(auth)
      .send({ ...base, secretKey: REDSYS_TEST_KEY })
      .expect(200);
    expect(ok.body).toMatchObject({ ok: true, status: 'ok' });

    const badKey = await http()
      .post('/settings/redsys/test')
      .set(auth)
      .send({ ...base, secretKey: 'invalidAAAAAAAAAAAAAAAAAAAAAAAAA' })
      .expect(200);
    expect(badKey.body).toMatchObject({ ok: false, status: 'bad_key', code: 'SIS0042' });

    const shortKey = await http()
      .post('/settings/redsys/test')
      .set(auth)
      .send({ ...base, secretKey: 'corta' })
      .expect(200);
    expect(shortKey.body).toMatchObject({ ok: false, status: 'bad_key' });

    const badMerchant = await http()
      .post('/settings/redsys/test')
      .set(auth)
      .send({ ...base, merchantCode: '000000000', secretKey: REDSYS_TEST_KEY })
      .expect(200);
    expect(badMerchant.body).toMatchObject({ ok: false, status: 'bad_merchant' });

    // No guarda nada: Redsys sigue sin clave.
    const settings = await http().get('/settings/redsys').set(auth).expect(200);
    expect(settings.body.hasSecretKey).toBe(false);

    // Con la clave guardada se prueba sin volver a escribirla.
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({ ...base, secretKey: REDSYS_TEST_KEY, enabled: false })
      .expect(200);
    const saved = await http().post('/settings/redsys/test').set(auth).send({}).expect(200);
    expect(saved.body.ok).toBe(true);
  });

  it('Cobros: cuenta las tarjetas y mandatos guardados por pasarela', async () => {
    const owner = await registerVerifiedUser(app, 'sisaved');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: customerId });
    const tenantId = (await admin.customer.findUniqueOrThrow({ where: { id: customerId } }))
      .tenantId;
    await admin.paymentMethod.create({
      data: {
        tenantId,
        customerId,
        type: 'card',
        gateway: 'redsys',
        gatewayTokenEncrypted: 'x',
        last4: '4242',
        isDefault: true,
      },
    });
    await admin.paymentMethod.create({
      data: {
        tenantId,
        customerId,
        type: 'card',
        gateway: 'stripe',
        gatewayTokenEncrypted: 'y',
        stripeAccountId: 'acct_stub_old',
        isDefault: false,
      },
    });

    const res = await http().get('/settings/payments/saved-methods-summary').set(auth).expect(200);
    expect(res.body.redsys).toEqual({ customers: 1, methods: 1, autoChargedContracts: 1 });
    expect(res.body.stripe).toMatchObject({ customers: 1, methods: 1, autoChargedContracts: 0 });
    expect(res.body.stripe.byAccount).toEqual([
      { stripeAccountId: 'acct_stub_old', customers: 1, methods: 1 },
    ]);
    expect(res.body.gocardless.methods).toBe(0);
    expect(res.body.sepa.methods).toBe(0);
    expect(res.body.autoChargeOnIssue).toBe(false);

    await http().get('/settings/payments/saved-methods-summary').expect(401);
  });

  it('Escalado: los recordatorios salen también por WhatsApp y quedan en Comunicaciones', async () => {
    const owner = await registerVerifiedUser(app, 'siwadun');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const dunning = app.get(DunningService);

    const current = await http().get('/dunning/settings').set(auth).expect(200);
    expect(current.body).toMatchObject({ whatsappReminders: false, whatsappAvailable: false });
    const {
      collectionsEnabled: _c,
      templates: _t,
      whatsappAvailable: _a,
      ...input
    } = current.body as Record<string, unknown>;

    // Sin WhatsApp conectado no se puede activar.
    const blocked = await http()
      .put('/dunning/settings')
      .set(auth)
      .send({ ...input, whatsappReminders: true })
      .expect(400);
    expect(blocked.body.code).toBe('whatsapp_not_available');

    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({
        phoneNumberId: `9${Date.now()}`,
        accessToken: 'EAAG-token-de-prueba-123456',
        enabled: true,
      })
      .expect(200);

    const saved = await http()
      .put('/dunning/settings')
      .set(auth)
      .send({
        ...input,
        whatsappReminders: true,
        whatsappTemplateName: 'recordatorio_pago',
        whatsappTemplateLanguage: 'es',
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      whatsappReminders: true,
      whatsappAvailable: true,
      whatsappTemplateName: 'recordatorio_pago',
      whatsappTemplateLanguage: 'es',
    });
    expect(saved.body.templates.whatsapp).toEqual(expect.any(String));

    // Inquilino con móvil y factura vencida.
    const customerId = await createCustomer(app, owner.accessToken);
    const phone = `6${String(Date.now()).slice(-8)}`;
    const customer = await admin.customer.update({
      where: { id: customerId },
      data: { phone },
    });
    const tenantId = customer.tenantId;
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 10 * 86_400_000) },
    });
    await dunning.handleJob(JOB_DUNNING_PROCESS_INVOICE, { tenantId, invoiceId, daysOverdue: 10 });

    // Ventana abierta: sale como texto.
    await admin.whatsappConversation.create({
      data: { tenantId, waId: `34${phone}`, customerId, lastInboundAt: new Date() },
    });
    const execute = async (type: 'email_reminder' | 'email_reminder_final') => {
      const action = await admin.dunningAction.findFirstOrThrow({
        where: { invoiceId, actionType: type },
      });
      await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId, actionId: action.id });
      return admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } });
    };
    const first = await execute('email_reminder');
    expect(first.result).toMatchObject({ emailEnqueued: true, whatsapp: 'sent' });

    // Ventana cerrada: con la plantilla de Meta.
    await admin.whatsappConversation.updateMany({
      where: { tenantId, waId: `34${phone}` },
      data: { lastInboundAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const final = await execute('email_reminder_final');
    expect(final.result).toMatchObject({ whatsapp: 'template' });

    const wa = await admin.communication.findMany({
      where: { tenantId, invoiceId, channel: 'whatsapp' },
      orderBy: { createdAt: 'asc' },
    });
    expect(wa.map((c) => [c.source, c.status])).toEqual([
      ['dunning.whatsapp_reminder', 'sent'],
      ['dunning.whatsapp_reminder_final', 'sent'],
    ]);
    expect(wa[0]!.bodyText).toContain('€');
    expect(wa[0]!.bodyText).toContain('/portal/login?slug=');
    expect(wa[1]!.whatsappTemplateName).toBe('recordatorio_pago');
    // Se ven en Comunicaciones del panel.
    const listed = await http().get(`/communications?invoiceId=${invoiceId}`).set(auth).expect(200);
    expect(
      (listed.body as { source: string | null }[]).some(
        (c) => c.source === 'dunning.whatsapp_reminder',
      ),
    ).toBe(true);
  });

  it('Escalado: no se manda por WhatsApp a quien se dio de baja', async () => {
    const owner = await registerVerifiedUser(app, 'siwaopt');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const dunning = app.get(DunningService);
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({
        phoneNumberId: `8${Date.now()}`,
        accessToken: 'EAAG-token-de-prueba-123456',
        enabled: true,
      })
      .expect(200);
    const current = await http().get('/dunning/settings').set(auth).expect(200);
    const {
      collectionsEnabled: _c,
      templates: _t,
      whatsappAvailable: _a,
      ...input
    } = current.body as Record<string, unknown>;
    await http()
      .put('/dunning/settings')
      .set(auth)
      .send({ ...input, whatsappReminders: true })
      .expect(200);

    const customerId = await createCustomer(app, owner.accessToken);
    const customer = await admin.customer.update({
      where: { id: customerId },
      data: { phone: '612345678', whatsappOptOutAt: new Date() },
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 10 * 86_400_000) },
    });
    const tenantId = customer.tenantId;
    await dunning.handleJob(JOB_DUNNING_PROCESS_INVOICE, { tenantId, invoiceId, daysOverdue: 10 });
    const action = await admin.dunningAction.findFirstOrThrow({
      where: { invoiceId, actionType: 'email_reminder' },
    });
    await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId, actionId: action.id });
    const done = await admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(done.result).toMatchObject({ emailEnqueued: true, whatsapp: 'opted_out' });
    const wa = await admin.communication.findFirstOrThrow({
      where: { tenantId, invoiceId, channel: 'whatsapp' },
    });
    expect(wa.status).toBe('skipped');
    expect(await admin.whatsappMessage.count({ where: { tenantId } })).toBe(0);
  });
});
