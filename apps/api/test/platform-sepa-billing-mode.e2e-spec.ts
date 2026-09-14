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

const ADMIN_EMAIL = 'admin-platform-sepa-test@storageos.local';

/**
 * Fase 1 del cobro SaaS por SEPA directo (BBVA): config del acreedor de
 * plataforma (singleton), mandato del tenant (autoservicio) y el modo de
 * cobro `billingMode` ('manual'|'stripe'|'sepa') + su switch admin. Sin
 * generación de remesas todavía (Fase 2).
 */
describe('Platform SEPA — billingMode (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    // Singleton global (sin tenantId): cleanupTestTenants() no lo toca, y un
    // run previo puede dejarlo configurado — se limpia explícitamente.
    await adminClient.platformSepaSettings.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Platform SEPA Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login falló: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await app.close();
    await cleanupTestTenants();
  });

  const adminAuth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  it('config del acreedor de plataforma (singleton): sin configurar → IBAN obligatorio la 1ª vez → guardado cifrado', async () => {
    const before = await request(app.getHttpServer())
      .get('/admin/platform-sepa/settings')
      .set(adminAuth());
    expect(before.status).toBe(200);
    expect(before.body.configured).toBe(false);

    // Primera vez sin IBAN → 400.
    const noIban = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({ creditorName: 'TrasterOS SL', creditorId: 'ES12ZZZ12345678', enabled: false });
    expect(noIban.status).toBe(400);
    expect(noIban.body.code).toBe('iban_required');

    // IBAN inválido (dígito de control incorrecto) → 400.
    const badIban = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({
        creditorName: 'TrasterOS SL',
        creditorId: 'ES12ZZZ12345678',
        creditorIban: 'ES0000000000000000000000',
        enabled: false,
      });
    expect(badIban.status).toBe(400);

    // Configuración válida.
    const ok = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({
        creditorName: 'TrasterOS SL',
        creditorId: 'ES12ZZZ12345678',
        creditorIban: 'ES9121000418450200051332',
        creditorBic: 'BBVAESMMXXX',
        enabled: true,
      });
    expect(ok.status).toBe(200);
    expect(ok.body.configured).toBe(true);
    expect(ok.body.creditorIbanLast4).toBe('1332');
    expect(ok.body.enabled).toBe(true);

    // Actualizar sin reescribir el IBAN conserva el ya guardado.
    const keepIban = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({ creditorName: 'TrasterOS SL', creditorId: 'ES12ZZZ12345678', enabled: true });
    expect(keepIban.status).toBe(200);
    expect(keepIban.body.creditorIbanLast4).toBe('1332');

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer()).get('/admin/platform-sepa/settings');
    expect(noAuth.status).toBe(401);
  });

  it('mandato SEPA del tenant: autoservicio, guarda solo un activo a la vez, bloquea cancelar en modo sepa', async () => {
    const owner = await registerVerifiedUser(app, 'sepa-mandate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin mandato al principio.
    const empty = await request(app.getHttpServer())
      .get('/settings/saas-billing/sepa-mandate')
      .set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.mandate).toBeNull();

    // IBAN inválido → 400.
    const badIban = await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES0000000000000000000000', signedAt: '2026-09-15' });
    expect(badIban.status).toBe(400);

    // Alta válida.
    const created = await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES9121000418450200051332', bic: 'BBVAESMMXXX', signedAt: '2026-09-15' });
    expect(created.status).toBe(200);
    expect(created.body.reference).toMatch(/^MND-/);
    expect(created.body.ibanLast4).toBe('1332');
    expect(created.body.sequenceType).toBe('FRST');
    expect(created.body.status).toBe('active');

    // GET refleja el mandato.
    const got = await request(app.getHttpServer())
      .get('/settings/saas-billing/sepa-mandate')
      .set(auth);
    expect(got.body.mandate.id).toBe(created.body.id);

    // Reemplazo: el anterior queda cancelado, solo uno activo.
    const replaced = await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES6621000418401234567891', signedAt: '2026-09-16' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.id).not.toBe(created.body.id);
    const oldMandate = await adminClient.platformSepaMandate.findUnique({
      where: { id: created.body.id },
    });
    expect(oldMandate?.status).toBe('cancelled');

    // Pasar a modo sepa exige el mandato activo (ya lo tiene) → admin lo activa.
    const toSepa = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' });
    expect(toSepa.status).toBe(200);
    expect(toSepa.body.subscription.billingMode).toBe('sepa');

    // Cancelar el mandato en modo sepa → 400 bloqueado.
    const blockedCancel = await request(app.getHttpServer())
      .delete('/settings/saas-billing/sepa-mandate')
      .set(auth);
    expect(blockedCancel.status).toBe(400);
    expect(blockedCancel.body.code).toBe('mode_requires_mandate');

    // Vuelve a manual → ahora sí puede cancelar.
    const toManual = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'manual' });
    expect(toManual.status).toBe(200);
    expect(toManual.body.subscription.billingMode).toBe('manual');

    const cancelled = await request(app.getHttpServer())
      .delete('/settings/saas-billing/sepa-mandate')
      .set(auth);
    expect(cancelled.status).toBe(204);

    const afterCancel = await request(app.getHttpServer())
      .get('/settings/saas-billing/sepa-mandate')
      .set(auth);
    expect(afterCancel.body.mandate).toBeNull();
  });

  it('setBillingMode: exige mandato para pasar a sepa, guarda already_in_mode, admin ve/cancela el mandato', async () => {
    const owner = await registerVerifiedUser(app, 'billing-mode');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Recién registrado: manual por defecto (sin Stripe).
    const detail0 = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set(adminAuth());
    expect(detail0.body.subscription.billingMode).toBe('manual');

    // Sin mandato → 400 no_active_mandate.
    const noMandate = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' });
    expect(noMandate.status).toBe(400);
    expect(noMandate.body.code).toBe('no_active_mandate');

    // Da de alta el mandato y reintenta.
    await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES9121000418450200051332', signedAt: '2026-09-15' });
    const toSepa = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' });
    expect(toSepa.status).toBe(200);
    expect(toSepa.body.subscription.billingMode).toBe('sepa');

    // Repetir el mismo modo → 400 already_in_mode.
    const already = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' });
    expect(already.status).toBe(400);
    expect(already.body.code).toBe('already_in_mode');

    // El admin ve el mandato del tenant (soporte, solo lectura).
    const adminMandate = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/sepa-mandate`)
      .set(adminAuth());
    expect(adminMandate.status).toBe(200);
    expect(adminMandate.body.mandate.status).toBe('active');

    // Vuelve a manual, y el admin cancela el mandato por soporte.
    await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'manual' });
    const adminCancel = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/sepa-mandate/cancel`)
      .set(adminAuth());
    expect(adminCancel.status).toBe(200);
    const afterAdminCancel = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/sepa-mandate`)
      .set(adminAuth());
    expect(afterAdminCancel.body.mandate).toBeNull();

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .send({ mode: 'sepa' });
    expect(noAuth.status).toBe(401);
  });

  it('regresión: /switch-to-manual sigue funcionando y ahora también fija billingMode', async () => {
    const owner = await registerVerifiedUser(app, 'switch-manual-regr');

    // Simula un tenant ya suscrito por Stripe (backfill de la migración lo
    // habría puesto en billingMode='stripe').
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeSubscriptionId: 'sub_fake_123', billingMode: 'stripe' },
    });

    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/switch-to-manual`)
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.subscription.stripeSubscriptionId).toBeNull();
    expect(res.body.subscription.billingMode).toBe('manual');

    // Repetir (ya está en manual) → 400 already_in_mode.
    const again = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/switch-to-manual`)
      .set(adminAuth());
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('already_in_mode');
  });
});
