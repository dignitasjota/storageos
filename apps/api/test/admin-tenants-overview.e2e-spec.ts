import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-ov-test@storageos.local';

describe('Admin: visión general de tenants y búsqueda (e2e)', () => {
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
        fullName: 'Admin OV Test',
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

  it('una fila por tenant con lo que aporta, sus extras, deuda y propietario', async () => {
    const owner = await registerVerifiedUser(app, 'adminov');
    const tenant = await adminClient.tenant.findUniqueOrThrow({
      where: { slug: owner.slug },
      include: { subscription: { include: { plan: true } } },
    });
    await adminClient.user.updateMany({
      where: { tenantId: tenant.id, role: 'owner' },
      data: { phone: '+34600111222' },
    });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-ov-addon' },
      update: {},
      create: { slug: 'e2e-ov-addon', name: 'Extra OV', priceMonthly: 10 },
    });
    await adminClient.tenantSubscriptionAddon.create({
      data: { tenantId: tenant.id, addonId: addon.id, priceMonthly: 10, quantity: 2 },
    });
    await adminClient.tenant.update({ where: { id: tenant.id }, data: { status: 'active' } });
    const periodEnd = new Date(Date.now() - 3 * 86_400_000);
    await adminClient.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { status: 'past_due', currentPeriodEnd: periodEnd },
    });
    await adminClient.tenantFollowup.create({
      data: { tenantId: tenant.id, title: 'Llamar', dueDate: new Date('2030-01-01') },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/tenants-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.find((r: { id: string }) => r.id === tenant.id);
    expect(row).toBeDefined();
    expect(row.monthly).toBeCloseTo(Number(tenant.subscription!.plan.priceMonthly) + 20, 2);
    expect(row.addons).toEqual([{ slug: 'e2e-ov-addon', name: 'Extra OV', suspended: false }]);
    expect(row.overdueSince).toBe(periodEnd.toISOString());
    expect(row.ownerPhone).toBe('+34600111222');
    expect(row.nextFollowup).toEqual({ title: 'Llamar', dueDate: '2030-01-01' });

    await request(app.getHttpServer()).get('/admin/tenants-overview').expect(401);
    await adminClient.tenantSubscriptionAddon.deleteMany({ where: { addonId: addon.id } });
    await adminClient.subscriptionAddon.delete({ where: { id: addon.id } });
  });

  it('la búsqueda encuentra tenants por email de un usuario y tickets por asunto', async () => {
    const owner = await registerVerifiedUser(app, 'adminsearch');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await adminClient.supportTicket.create({
      data: { tenantId: tenant.id, subject: 'Problema raro con zzremesa' },
    });
    const auth = { Authorization: `Bearer ${token}` };

    const byEmail = await request(app.getHttpServer())
      .get(`/admin/search?q=${encodeURIComponent(owner.email)}`)
      .set(auth)
      .expect(200);
    expect(byEmail.body.tenants.map((t: { id: string }) => t.id)).toContain(tenant.id);

    const byTicket = await request(app.getHttpServer())
      .get('/admin/search?q=zzremesa')
      .set(auth)
      .expect(200);
    expect(byTicket.body.tickets[0]).toMatchObject({ tenantId: tenant.id });

    const short = await request(app.getHttpServer()).get('/admin/search?q=a').set(auth).expect(200);
    expect(short.body).toEqual({ tenants: [], tickets: [] });
  });
});
