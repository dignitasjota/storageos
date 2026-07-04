import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Staff: subpágina de pases nocturnos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el staff ve los pases nocturnos comprados + los ingresos', async () => {
    const owner = await registerVerifiedUser(app, 'staffnp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    // Sin pases: lista vacía + revenue 0.
    const empty = await request(app.getHttpServer())
      .get('/access/credentials/night-passes')
      .set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.total).toBe(0);
    expect(empty.body.revenue).toBe(0);

    // Activar el pase nocturno GRATUITO + un inquilino que compra uno. Un pase
    // de pago se cobra en el acto (exige método de pago, no ejercitable sin
    // pasarela en test); el gratuito valida que el staff ve los pases emitidos.
    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);
    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Nel',
      lastName: 'Sol',
      email: 'nel-np@x.com',
    });
    const link = await request(app.getHttpServer())
      .post(`/customers/${customer.body.id}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set({ Authorization: `Bearer ${consume.body.accessToken}` })
      .expect(201);

    // El staff lo ve: 1 pase «sin usar» (active). Gratuito → sin ingresos.
    const list = await request(app.getHttpServer())
      .get('/access/credentials/night-passes')
      .set(auth);
    expect(list.body.total).toBe(1);
    expect(list.body.active).toBe(1);
    expect(list.body.passes[0].customerName).toBe('Nel Sol');
    expect(list.body.passes[0].status).toBe('active');
    expect(list.body.revenue).toBe(0);

    // Y aparece marcado en la lista de credenciales (label «Pase nocturno»).
    const creds = await request(app.getHttpServer()).get('/access/credentials').set(auth);
    expect(creds.body.some((c: { label: string }) => c.label === 'Pase nocturno')).toBe(true);
  });
});
