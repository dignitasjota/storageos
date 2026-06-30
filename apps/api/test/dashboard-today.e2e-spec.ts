import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Dashboard: bandeja «Hoy» (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve la bandeja operativa del día', async () => {
    const owner = await registerVerifiedUser(app, 'today');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer()).get('/dashboard/today').expect(401);

    const res = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(res.status).toBe(200);
    // Estructura del DTO (tenant nuevo → todo a 0).
    expect(res.body.tasksDue).toEqual({ count: 0, items: [] });
    expect(res.body.contractsEndingSoon).toEqual({ count: 0, items: [] });
    expect(res.body.reservationsExpiring).toEqual({ count: 0, items: [] });
    expect(res.body.invoicesOverdue).toEqual({ count: 0, totalPending: 0 });
    expect(res.body.incidentsOpen).toBe(0);
    expect(res.body.unitChangesPending).toBe(0);
    expect(res.body.unreadMessages).toBe(0);
  });
});
