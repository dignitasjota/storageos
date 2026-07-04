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

  async function portalAuthFor(
    ownerToken: string,
    customer: { firstName: string; lastName: string; email: string },
  ): Promise<{ headers: { Authorization: string } }> {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const created = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', ...customer });
    const customerId = created.body.id as string;
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return { headers: { Authorization: `Bearer ${consume.body.accessToken}` } };
  }

  // Cobro en el acto (decisión de negocio): un pase con precio se cobra contra
  // el método de pago por defecto del inquilino ANTES de emitir el PIN. Sin
  // método → 400 y no se emite nada (el PIN es usable de inmediato, no puede
  // entregarse gratis).
  it('con precio y sin método de pago → 400 y NO se emite el pase', async () => {
    const owner = await registerVerifiedUser(app, 'nightpass');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 5 })
      .expect(200);

    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Sol',
      lastName: 'Noche',
      email: 'sol-np@x.com',
    });

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/portal/me/access/night-passes').expect(401);

    // Comprar sin método de pago → 400 `no_payment_method`.
    const buy = await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers);
    expect(buy.status).toBe(400);
    expect(buy.body.code).toBe('no_payment_method');

    // No se ha emitido ningún pase.
    const history = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth.headers);
    expect(history.body).toHaveLength(0);
  });

  it('pase gratuito (precio 0) se entrega sin cobro', async () => {
    const owner = await registerVerifiedUser(app, 'nightpassfree');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);

    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Luna',
      lastName: 'Gratis',
      email: 'luna-np@x.com',
    });

    await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .expect(201);

    const history = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth.headers);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].status).toBe('active');
  });
});
