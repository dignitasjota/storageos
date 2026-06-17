import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

describe('Insights: churn risk + pricing suggestions (e2e)', () => {
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

  it('tenant vacío: churn risk con todo a cero', async () => {
    const owner = await registerVerifiedUser(app, 'ins-empty');
    const res = await request(app.getHttpServer())
      .get('/analytics/churn-risk')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
    expect(res.body.items).toEqual([]);
  });

  it('contrato que vence pronto sin renovación ni método de pago → riesgo medio con factores', async () => {
    const owner = await registerVerifiedUser(app, 'ins-churn');
    const { unitIds, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    void unitTypeId;
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        unitId: unitIds[0]!,
        startDate: isoDate(-10),
        endDate: isoDate(20),
        priceMonthly: 100,
        autoRenew: false,
      });
    expect(create.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${create.body.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});

    const res = await request(app.getHttpServer())
      .get('/analytics/churn-risk')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    // 25 (vence pronto sin auto-renovación) + 15 (sin método de pago) = 40 → medium.
    expect(res.body.summary.medium).toBe(1);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.level).toBe('medium');
    expect(item.score).toBe(40);
    expect(item.contractId).toBe(create.body.id);
    expect(item.factors.length).toBeGreaterThanOrEqual(2);
  });

  it('pricing suggestions: 50% de ocupación recomienda bajar precio', async () => {
    const owner = await registerVerifiedUser(app, 'ins-pricing');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 80,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Firmar un contrato sobre 1 de las 2 units → 50% ocupación del tipo.
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        unitId: unitIds[0]!,
        startDate: isoDate(-5),
        priceMonthly: 80,
      });
    expect(create.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${create.body.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});

    const res = await request(app.getHttpServer())
      .get('/analytics/pricing-suggestions')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.totalUnits).toBe(2);
    expect(item.occupiedUnits).toBe(1);
    expect(item.occupancy).toBe(50);
    expect(item.currentPrice).toBe(80);
    expect(item.action).toBe('lower');
    expect(item.changePct).toBe(-5);
    expect(item.suggestedPrice).toBe(76);
  });

  it('forecast: refleja el MRR actual y proyecta el horizonte solicitado', async () => {
    const owner = await registerVerifiedUser(app, 'ins-forecast');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 120,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        unitId: unitIds[0]!,
        startDate: isoDate(-5),
        priceMonthly: 120,
      });
    expect(create.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${create.body.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});

    const res = await request(app.getHttpServer())
      .get('/analytics/forecast?months=4')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.current.activeContracts).toBe(1);
    expect(res.body.current.mrr).toBe(120);
    expect(res.body.current.totalUnits).toBe(2);
    expect(res.body.points).toHaveLength(4);
    expect(res.body.assumptions.avgContractValue).toBe(120);
    expect(res.body.points[0].yearMonth).toMatch(/^\d{4}-\d{2}$/);
  });
});
