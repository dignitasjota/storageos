import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Customer interactions (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('registra, lista y borra interacciones; aísla por tenant', async () => {
    const owner = await registerVerifiedUser(app, 'ci-owner');
    const customerId = await createCustomer(app, owner.accessToken);

    // Lista vacía al principio.
    const empty = await request(app.getHttpServer())
      .get(`/customers/${customerId}/interactions`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    // Crea una llamada.
    const created = await request(app.getHttpServer())
      .post(`/customers/${customerId}/interactions`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ type: 'call', content: 'Llamada de seguimiento; renovará el contrato.' });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe('call');
    expect(created.body.userName).toBeTruthy();
    const interactionId = created.body.id;

    // Aparece en la lista.
    const list = await request(app.getHttpServer())
      .get(`/customers/${customerId}/interactions`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].content).toContain('renovará');

    // Otro tenant no la ve (RLS).
    const other = await registerVerifiedUser(app, 'ci-other');
    const cross = await request(app.getHttpServer())
      .get(`/customers/${customerId}/interactions`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    // El customer pertenece a otro tenant → lista vacía bajo su contexto RLS.
    expect(cross.body).toEqual([]);

    // Borra.
    const del = await request(app.getHttpServer())
      .delete(`/customers/${customerId}/interactions/${interactionId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(del.status).toBe(204);

    const afterDelete = await request(app.getHttpServer())
      .get(`/customers/${customerId}/interactions`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(afterDelete.body).toEqual([]);
  });
});
