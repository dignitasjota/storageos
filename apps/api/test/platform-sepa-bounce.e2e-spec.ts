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

const ADMIN_EMAIL = 'admin-platform-sepa-bounce-test@storageos.local';

/**
 * Fase 3: devoluciones. Confirmar una remesa y luego que el banco devuelva
 * el adeudo (R-transaction) fuerza `past_due` explícitamente — y
 * `PlatformDunningService.run()` lo recoge SIN ningún cambio en
 * `platform-dunning.service.ts` (ya es agnóstico del origen del impago).
 */
describe('Platform SEPA — devoluciones/bounce (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.platformSepaSettings.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Platform SEPA Bounce Test',
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

    await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set({ Authorization: `Bearer ${superAdminToken}` })
      .send({
        creditorName: 'TrasterOS SL',
        creditorId: 'ES12ZZZ12345678',
        creditorIban: 'ES9121000418450200051332',
        enabled: true,
      });
  });

  afterAll(async () => {
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.platformSepaSettings.deleteMany({});
    await adminClient.$disconnect();
    await app.close();
    await cleanupTestTenants();
  });

  const adminAuth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  it('confirmar → devolver → past_due explícito → el dunning ya existente lo recoge sin cambios', async () => {
    // `run()` evalúa TODOS los tenants past_due de la BD compartida de test
    // (no solo el de este spec) — con muchas suites e2e acumuladas puede
    // tardar más de los 30s por defecto de Jest.
    // --- Da de alta el tenant en modo sepa, cobra la remesa. ---
    const owner = await registerVerifiedUser(app, 'sepa-bounce');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES9121000418450200051332', signedAt: '2026-09-01' });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' })
      .expect(200);
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: new Date(Date.now() + 2 * 24 * 3600 * 1000), status: 'active' },
    });

    const created = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances')
      .set(adminAuth())
      .send({
        name: 'Remesa con devolución',
        collectionDate: '2026-09-25',
        tenantIds: [owner.tenantId],
      });
    expect(created.status).toBe(201);

    const confirm = await request(app.getHttpServer())
      .post(`/admin/platform-sepa/remittances/${created.body.id}/confirm`)
      .set(adminAuth());
    expect(confirm.status).toBe(200);

    const subAfterConfirm = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(subAfterConfirm!.status).toBe('active');

    const item = await adminClient.platformSepaRemittanceItem.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(item.itemStatus).toBe('collected');

    // --- El banco devuelve el adeudo (R-transaction). ---
    const bounced = await request(app.getHttpServer())
      .post(`/admin/platform-sepa/remittance-items/${item.id}/bounce`)
      .set(adminAuth())
      .send({ reason: 'Cuenta cerrada' });
    expect(bounced.status).toBe(200);

    const alreadyBounced = await request(app.getHttpServer())
      .post(`/admin/platform-sepa/remittance-items/${item.id}/bounce`)
      .set(adminAuth())
      .send({});
    expect(alreadyBounced.status).toBe(400);
    expect(alreadyBounced.body.code).toBe('item_not_collected');

    // El item queda `bounced` con el motivo, el periodo/pago no se revierte,
    // y la suscripción pasa a `past_due` EXPLÍCITAMENTE.
    const itemAfter = await adminClient.platformSepaRemittanceItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(itemAfter.itemStatus).toBe('bounced');
    expect(itemAfter.bounceReason).toBe('Cuenta cerrada');
    expect(itemAfter.bouncedAt).not.toBeNull();

    const subAfterBounce = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(subAfterBounce!.status).toBe('past_due');
    // El periodo NO se revierte (recordManualPayment ya lo adelantó al confirmar).
    expect(subAfterBounce!.currentPeriodEnd.getTime()).toBe(
      subAfterConfirm!.currentPeriodEnd.getTime(),
    );

    // --- El dunning YA EXISTENTE (sin cambios) recoge el past_due. ---
    // Simula que, además, el periodo (ya adelantado al confirmar) venció
    // hace tiempo — así `run()` lo evalúa sin depender de la fecha exacta
    // de la extensión.
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 25 * 24 * 3600 * 1000) },
    });
    await request(app.getHttpServer())
      .put('/admin/platform-dunning/settings')
      .set(adminAuth())
      .send({ enabled: true, reminder1Days: 3, reminder2Days: 10, suspendDays: 21 })
      .expect(200);

    const run = await request(app.getHttpServer())
      .post('/admin/platform-dunning/run')
      .set(adminAuth());
    expect(run.status).toBe(201);
    expect(run.body.evaluated).toBeGreaterThanOrEqual(1);
    expect(run.body.suspended).toBeGreaterThanOrEqual(1);

    const tenantDetail = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set(adminAuth());
    expect(tenantDetail.body.status).toBe('suspended');

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer()).post(
      `/admin/platform-sepa/remittance-items/${item.id}/bounce`,
    );
    expect(noAuth.status).toBe(401);
  }, 60_000);

  it('devolver un item ya pendiente (nunca confirmado) → 400', async () => {
    const owner = await registerVerifiedUser(app, 'sepa-bounce-pending');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES6621000418401234567891', signedAt: '2026-09-01' });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' })
      .expect(200);
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: new Date(Date.now() + 1 * 24 * 3600 * 1000), status: 'active' },
    });

    const created = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances')
      .set(adminAuth())
      .send({
        name: 'Remesa sin confirmar',
        collectionDate: '2026-09-25',
        tenantIds: [owner.tenantId],
      });
    expect(created.status).toBe(201);

    const item = await adminClient.platformSepaRemittanceItem.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(item.itemStatus).toBe('pending');

    const bounce = await request(app.getHttpServer())
      .post(`/admin/platform-sepa/remittance-items/${item.id}/bounce`)
      .set(adminAuth())
      .send({});
    expect(bounce.status).toBe(400);
    expect(bounce.body.code).toBe('item_not_collected');
  });
});
