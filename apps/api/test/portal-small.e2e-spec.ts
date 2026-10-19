import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Portal: avisos enviados, métodos de pago y seguro según el plan. */
describe('Portal: avisos y métodos de pago (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('enseña los avisos sin secretos y gestiona los métodos de pago', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'portalsmall');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `small-${Date.now()}@example.com`,
    });

    await db.communication.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          customerId,
          recipient: 'x@example.com',
          subject: 'Tu acceso',
          bodyText: 'Tu PIN es [[SECRET-1]].',
          status: 'sent',
          sentAt: new Date('2026-10-01'),
        },
        {
          tenantId: owner.tenantId,
          customerId,
          recipient: 'x@example.com',
          subject: 'No enviado',
          bodyText: 'pendiente',
          status: 'pending',
        },
      ],
    });
    const [a, b] = await Promise.all(
      [true, false].map((isDefault, i) =>
        db.paymentMethod.create({
          data: {
            tenantId: owner.tenantId,
            customerId,
            type: 'card',
            gateway: 'stripe',
            gatewayTokenEncrypted: 'x',
            last4: `424${i}`,
            isDefault,
          },
        }),
      ),
    );

    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url).searchParams.get('token');
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const pAuth = { Authorization: `Bearer ${session.body.accessToken}` };

    const notices = await http().get('/portal/me/notices').set(pAuth).expect(200);
    expect(notices.body).toHaveLength(1);
    expect(notices.body[0]).toMatchObject({ subject: 'Tu acceso', body: 'Tu PIN es ••••.' });

    const def = await http()
      .post(`/portal/me/payment-methods/${b!.id}/default`)
      .set(pAuth)
      .expect(200);
    expect(def.body.find((p: { id: string }) => p.id === b!.id).isDefault).toBe(true);
    expect(def.body.find((p: { id: string }) => p.id === a!.id).isDefault).toBe(false);

    // Quitar el predeterminado pasa a predeterminado el otro.
    const left = await http().delete(`/portal/me/payment-methods/${b!.id}`).set(pAuth).expect(200);
    expect(left.body).toHaveLength(1);
    expect(left.body[0]).toMatchObject({ id: a!.id, isDefault: true });

    // Otro inquilino no puede tocar sus métodos.
    const other = await createCustomer(app, owner.accessToken, {
      email: `other-${Date.now()}@example.com`,
    });
    const otherLink = await http().post(`/customers/${other}/portal-link`).set(auth).expect(201);
    const otherSession = await http()
      .post('/portal/login/consume')
      .send({ token: new URL(otherLink.body.url).searchParams.get('token') })
      .expect(200);
    await http()
      .delete(`/portal/me/payment-methods/${a!.id}`)
      .set({ Authorization: `Bearer ${otherSession.body.accessToken}` })
      .expect(404);

    // Sin la protección en el plan no se ofrecen planes de seguro.
    await http()
      .post('/insurance-plans')
      .set(auth)
      .send({ name: 'Básica', monthlyPrice: 5, coverageAmount: 1000 })
      .expect(201);
    const withPlan = await http().get('/portal/me/insurance-plans').set(pAuth).expect(200);
    expect(withPlan.body).toHaveLength(1);
    await setTenantPlan(owner.slug, 'free');
    const without = await http().get('/portal/me/insurance-plans').set(pAuth).expect(200);
    expect(without.body).toHaveLength(0);

    await http().get('/portal/me/notices').expect(401);
  });
});
