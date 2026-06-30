import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: CRUD de planes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('crea, edita y desactiva un plan con todos los campos', async () => {
    const admin = await seedSuperAdmin('plans');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const slug = `test-plan-${Date.now()}`;

    await request(app.getHttpServer()).get('/subscription-plans/admin').expect(401);

    // Crear.
    const created = await request(app.getHttpServer()).post('/subscription-plans').set(auth).send({
      slug,
      name: 'Plan de prueba',
      priceMonthly: 29,
      priceYearly: 290,
      currency: 'EUR',
      features: {},
      maxUnits: 500,
      maxFacilities: 5,
      maxUsers: 10,
      isActive: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.priceYearly).toBe(290);
    expect(created.body.maxFacilities).toBe(5);
    const id = created.body.id as string;

    // Aparece en el listado admin.
    const list = await request(app.getHttpServer()).get('/subscription-plans/admin').set(auth);
    expect(list.body.some((p: { id: string }) => p.id === id)).toBe(true);

    // Editar el precio.
    const updated = await request(app.getHttpServer())
      .patch(`/subscription-plans/${id}`)
      .set(auth)
      .send({ priceMonthly: 39 });
    expect(updated.status).toBe(200);
    expect(updated.body.priceMonthly).toBe(39);

    // Desactivar.
    await request(app.getHttpServer()).delete(`/subscription-plans/${id}`).set(auth).expect(204);
    const after = await request(app.getHttpServer()).get('/subscription-plans/admin').set(auth);
    expect(after.body.find((p: { id: string }) => p.id === id).isActive).toBe(false);
  });
});
