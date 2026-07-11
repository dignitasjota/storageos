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
const ADMIN_EMAIL = 'admin-addon-stripe-test@storageos.local';

/**
 * Cobro automático de add-ons por Stripe (v2, por add-on): estado Stripe del
 * catálogo, modo de cobro por add-on (manual↔stripe) y desglose por líneas de la
 * factura de plataforma. El cobro REAL por Stripe no se puede ejercitar sin una
 * clave real (STRIPE_SECRET_KEY=sk_test_dummy en tests), así que se valida la
 * guarda `payments_not_configured` y la persistencia del modo + las líneas.
 */
describe('Add-on Stripe billing (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Addon Stripe',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    // Deja la facturación de plataforma DESACTIVADA para no forzar emisión de
    // facturas (Puppeteer) en otras specs que registran pagos manuales.
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set({ Authorization: `Bearer ${token}` })
      .send({ legalName: 'StorageOS SL', taxId: 'B1', enabled: false });
    await app.close();
    await adminClient.subscriptionAddon.deleteMany({
      where: { slug: { startsWith: 'e2e-strp-' } },
    });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${token}` });

  it('catálogo sin Price de Stripe; add-on asignado arranca en modo manual; toggle a Stripe requiere Stripe configurado', async () => {
    // Add-on del catálogo → sin Price de Stripe todavía.
    const addon = await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer())
      .send({ slug: 'e2e-strp-extra', name: 'Extra de prueba', priceMonthly: 10 });
    expect(addon.status).toBe(201);
    expect(addon.body.stripePriceId).toBeNull();

    const owner = await registerVerifiedUser(app, 'addon-strp');
    const tenantId = owner.tenantId;

    // Asignar → el add-on arranca en modo de cobro MANUAL.
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addon.body.id, quantity: 1 });
    expect(assign.status).toBe(201);
    const assignment = assign.body.addons[0];
    expect(assignment.billingMode).toBe('manual');
    const assignmentId = assignment.id as string;

    // Cambiar a un modo en el que YA está (manual → manual) → 400 already_in_mode.
    const same = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/billing-mode`)
      .set(bearer())
      .send({ mode: 'manual' });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('already_in_mode');

    // Pasar a modo Stripe sin Stripe configurado (clave dummy en test) → 503.
    const toStripe = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/billing-mode`)
      .set(bearer())
      .send({ mode: 'stripe' });
    expect(toStripe.status).toBe(503);
    expect(toStripe.body.code).toBe('payments_not_configured');

    // Sigue en manual (el fallo no cambió el estado).
    const summary = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/billing-summary`)
      .set(bearer());
    expect(summary.body.addons[0].billingMode).toBe('manual');
  });

  it('la factura de plataforma se desglosa por líneas (plan vs add-on)', async () => {
    // Activar la facturación del SaaS para que los pagos emitan factura.
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set(bearer())
      .send({
        legalName: 'StorageOS SL',
        taxId: 'B12345678',
        country: 'ES',
        taxRate: 21,
        seriesPrefix: 'SAAS',
        enabled: true,
      })
      .expect(200);

    const owner = await registerVerifiedUser(app, 'addon-strp-inv');
    const tenantId = owner.tenantId;

    // Pago de suscripción (sin descripción) → línea de tipo 'plan'.
    const planPay = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/saas-payments/manual`)
      .set(bearer())
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 });
    expect(planPay.status).toBe(201);

    // Cobro puntual de un add-on (descripción «Add-on: …») → línea de tipo 'addon'.
    const addonPay = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/saas-payments/manual`)
      .set(bearer())
      .send({
        provider: 'cash',
        amount: 15,
        durationMonths: 1,
        extendsPeriod: false,
        description: 'Add-on: Extra de prueba',
      });
    expect(addonPay.status).toBe(201);

    const invoices = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/platform-invoices`)
      .set(bearer());
    expect(invoices.status).toBe(200);
    const byPayment = new Map<string, { lines: { kind: string; total: number }[] }>(
      invoices.body.map((inv: { paymentId: string; lines: { kind: string; total: number }[] }) => [
        inv.paymentId,
        inv,
      ]),
    );

    const planInv = byPayment.get(planPay.body.id);
    expect(planInv).toBeTruthy();
    expect(planInv!.lines).toHaveLength(1);
    expect(planInv!.lines[0].kind).toBe('plan');
    expect(planInv!.lines[0].total).toBe(121);

    const addonInv = byPayment.get(addonPay.body.id);
    expect(addonInv).toBeTruthy();
    expect(addonInv!.lines).toHaveLength(1);
    expect(addonInv!.lines[0].kind).toBe('addon');
    expect(addonInv!.lines[0].total).toBe(15);
  });

  it('sin token de super admin → 401', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants/00000000-0000-0000-0000-000000000000/addons/x/billing-mode')
      .send({ mode: 'stripe' })
      .expect(401);
  });
});
