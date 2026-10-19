import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { TenantLifecycleEmailsService } from '../src/modules/admin/tenant-lifecycle-emails.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-qa-test@storageos.local';

describe('Admin: simulador de cuota y ayuda para arrancar (e2e)', () => {
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
        fullName: 'Admin QA Test',
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

  it('calcula plan + extras por mes y por año, con IVA, cupón inválido y envío', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const plan = await adminClient.subscriptionPlan.findFirstOrThrow({
      where: { slug: 'starter' },
    });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-qa-addon' },
      update: {},
      create: { slug: 'e2e-qa-addon', name: 'Extra QA', priceMonthly: 10 },
    });
    const settings = await adminClient.platformBillingSettings.findFirst();
    const includeVat = settings?.pricesIncludeVat ?? true;

    const monthly = await request(app.getHttpServer())
      .post('/admin/quote')
      .set(auth)
      .send({ planId: plan.id, cycle: 'monthly', addons: [{ addonId: addon.id, quantity: 2 }] })
      .expect(200);
    const sub = Number(plan.priceMonthly) + 20;
    expect(monthly.body.subtotal).toBeCloseTo(sub, 2);
    expect(monthly.body.total).toBeCloseTo(includeVat ? sub : sub * 1.21, 2);
    expect(monthly.body.base + monthly.body.vat).toBeCloseTo(monthly.body.total, 2);

    const yearly = await request(app.getHttpServer())
      .post('/admin/quote')
      .set(auth)
      .send({ planId: plan.id, cycle: 'yearly', addons: [{ addonId: addon.id }] })
      .expect(200);
    expect(yearly.body.subtotal).toBeCloseTo(Number(plan.priceYearly) + 120, 2);
    expect(yearly.body.yearlySaving).toBeCloseTo(
      Math.max(0, Number(plan.priceMonthly) * 12 - Number(plan.priceYearly)),
      2,
    );

    const bad = await request(app.getHttpServer())
      .post('/admin/quote')
      .set(auth)
      .send({ planId: plan.id, couponCode: 'NOEXISTE' })
      .expect(200);
    expect(bad.body.couponError).toBeTruthy();
    expect(bad.body.discount).toBe(0);

    const owner = await registerVerifiedUser(app, 'adminquote');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const sent = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/quote-offers`)
      .set(auth)
      .send({ planId: plan.id, cycle: 'monthly', message: 'Te paso la propuesta', followupDays: 3 })
      .expect(201);
    expect(sent.body.recipients).toBe(1);
    expect(
      await adminClient.tenantInteraction.count({
        where: { tenantId: tenant.id, content: { startsWith: 'Propuesta de cuota' } },
      }),
    ).toBe(1);
    expect(await adminClient.tenantFollowup.count({ where: { tenantId: tenant.id } })).toBe(1);
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/quote-offers`)
      .set(auth)
      .send({ planId: plan.id, couponCode: 'NOEXISTE' })
      .expect(400);
  });

  it('ayuda para arrancar: solo el paso más avanzado que toca, una vez; el del día 12 deja seguimiento', async () => {
    const owner = await registerVerifiedUser(app, 'adminnudge');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const svc = app.get(TenantLifecycleEmailsService);
    const day = 86_400_000;
    await adminClient.tenant.update({
      where: { id: tenant.id },
      data: { status: 'trial', createdAt: new Date(Date.now() - 4 * day) },
    });
    await svc.runActivationNudges();
    const types = async () =>
      (await adminClient.tenantLifecycleEmail.findMany({ where: { tenantId: tenant.id } })).map(
        (e) => e.type,
      );
    expect(await types()).toContain('activation_facility');

    await adminClient.tenant.update({
      where: { id: tenant.id },
      data: { createdAt: new Date(Date.now() - 13 * day) },
    });
    await svc.runActivationNudges();
    await svc.runActivationNudges();
    const after = await types();
    expect(after.filter((t) => t === 'activation_invoice')).toHaveLength(1);
    expect(after).not.toContain('activation_customer');
    expect(
      await adminClient.tenantFollowup.count({
        where: { tenantId: tenant.id, title: { contains: 'sin facturar' } },
      }),
    ).toBe(1);
  });
});
