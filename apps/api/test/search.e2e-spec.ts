import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Búsqueda global (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('encuentra inquilinos por nombre/email y respeta el aislamiento por tenant', async () => {
    const owner = await registerVerifiedUser(app, 'search');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `buscame-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, {
      email,
      firstName: 'Zenón',
      lastName: 'Buscable',
    });

    await request(app.getHttpServer()).get('/search?q=zenon').expect(401);

    // < 2 caracteres → vacío.
    const short = await request(app.getHttpServer()).get('/search?q=z').set(auth);
    expect(short.status).toBe(200);
    expect(short.body.results).toHaveLength(0);

    // Por nombre.
    const byName = await request(app.getHttpServer()).get('/search?q=Buscable').set(auth);
    expect(byName.status).toBe(200);
    const hit = byName.body.results.find(
      (r: { type: string; id: string }) => r.type === 'customer' && r.id === customerId,
    );
    expect(hit).toBeTruthy();
    expect(hit.href).toBe(`/customers/${customerId}`);

    // Otro tenant no lo encuentra.
    const other = await registerVerifiedUser(app, 'searchb');
    const res = await request(app.getHttpServer())
      .get('/search?q=Buscable')
      .set({ Authorization: `Bearer ${other.accessToken}` });
    expect(res.body.results.some((r: { id: string }) => r.id === customerId)).toBe(false);
  });
});
