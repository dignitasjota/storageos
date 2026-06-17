import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Analytics — customer stats (e2e)', () => {
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

  it('requiere autenticación', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/customers');
    expect(res.status).toBe(401);
  });

  it('tenant vacío devuelve todos los contadores a 0', async () => {
    const owner = await registerVerifiedUser(app, 'cust-stats-empty');
    const res = await request(app.getHttpServer())
      .get('/analytics/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, withActiveContract: 0, newThisMonth: 0 });
  });

  it('cuenta inquilinos activos y altas del mes, sin contratos activos', async () => {
    const owner = await registerVerifiedUser(app, 'cust-stats-count');
    await createCustomer(app, owner.accessToken);
    await createCustomer(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .get('/analytics/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.newThisMonth).toBe(2);
    expect(res.body.withActiveContract).toBe(0);
  });

  it('los contadores están aislados por tenant (RLS)', async () => {
    const tenantA = await registerVerifiedUser(app, 'cust-stats-a');
    await createCustomer(app, tenantA.accessToken);
    await createCustomer(app, tenantA.accessToken);
    await createCustomer(app, tenantA.accessToken);

    const tenantB = await registerVerifiedUser(app, 'cust-stats-b');

    const resA = await request(app.getHttpServer())
      .get('/analytics/customers')
      .set('Authorization', `Bearer ${tenantA.accessToken}`);
    const resB = await request(app.getHttpServer())
      .get('/analytics/customers')
      .set('Authorization', `Bearer ${tenantB.accessToken}`);

    expect(resA.body.total).toBe(3);
    expect(resB.body.total).toBe(0);
  });
});
