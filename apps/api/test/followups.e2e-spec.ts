import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Seguimientos sobre inquilinos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('crea, lista, marca hecho y borra un seguimiento', async () => {
    const owner = await registerVerifiedUser(app, 'followups');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `f-${Date.now()}@e2e.local`,
    });

    await request(app.getHttpServer()).get('/followups').expect(401);

    // Crear.
    const created = await request(app.getHttpServer())
      .post(`/customers/${customerId}/followups`)
      .set(auth)
      .send({ title: 'Llamar para renovación', dueDate: '2026-07-15' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(created.body.customerName).toBeTruthy();
    const id = created.body.id as string;

    // Bandeja: aparece pendiente.
    const pending = await request(app.getHttpServer()).get('/followups').set(auth);
    expect(pending.body.some((f: { id: string }) => f.id === id)).toBe(true);

    // En la ficha del cliente.
    const ofCustomer = await request(app.getHttpServer())
      .get(`/customers/${customerId}/followups`)
      .set(auth);
    expect(ofCustomer.body).toHaveLength(1);

    // Marcar hecho → sale de la bandeja.
    const done = await request(app.getHttpServer())
      .patch(`/followups/${id}`)
      .set(auth)
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.completedAt).toBeTruthy();
    const pending2 = await request(app.getHttpServer()).get('/followups').set(auth);
    expect(pending2.body.some((f: { id: string }) => f.id === id)).toBe(false);

    // Borrar.
    await request(app.getHttpServer()).delete(`/followups/${id}`).set(auth).expect(204);
    const after = await request(app.getHttpServer())
      .get(`/customers/${customerId}/followups`)
      .set(auth);
    expect(after.body).toHaveLength(0);
  });
});
