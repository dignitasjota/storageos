import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** El pago con tarjeta simulado solo existe en la cuenta de demostración. */
describe('Pago con tarjeta simulado fuera de la demo (e2e)', () => {
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

  it('un negocio real no lo ofrece y el endpoint da 403', async () => {
    const owner = await registerVerifiedUser(app, 'democard');
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `democard-${Date.now()}@e2e.local`,
    });
    const gen = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(201);
    const token = new URL(gen.body.url as string).searchParams.get('token');
    const session = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token })
      .expect(200);
    const portal = { Authorization: `Bearer ${session.body.accessToken}` };

    const options = await request(app.getHttpServer())
      .get('/portal/me/payments/options')
      .set(portal)
      .expect(200);
    expect(options.body.demoCard).toBe(false);

    const res = await request(app.getHttpServer())
      .post('/portal/me/invoices/00000000-0000-0000-0000-000000000000/demo-card-payment')
      .set(portal);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('demo_only');
  });
});
