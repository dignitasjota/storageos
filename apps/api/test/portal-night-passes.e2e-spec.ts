import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: historial de pases nocturnos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el inquilino compra un pase nocturno y aparece en su historial', async () => {
    const owner = await registerVerifiedUser(app, 'nightpass');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    // Activar el pase nocturno del tenant.
    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 5 })
      .expect(200);

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Sol',
        lastName: 'Noche',
        email: 'sol-np@x.com',
      });
    const customerId = customer.body.id as string;

    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const portalAuth = { Authorization: `Bearer ${consume.body.accessToken}` };

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/portal/me/access/night-passes').expect(401);

    // Historial inicial vacío.
    const before = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth);
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(0);

    // Compra un pase.
    await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth)
      .expect(201);

    // Aparece en el historial como «sin usar» (active).
    const after = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].status).toBe('active');
  });
});
