import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Benchmarking anónimo entre tenants (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('GET /analytics/benchmark devuelve la estructura correcta', async () => {
    const owner = await registerVerifiedUser(app, 'benchmark');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Un local + tipo + dos trasteros (uno ocupado, uno disponible).
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local BM', addressLine1: 'C/ B 1', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;

    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 80 });
    const unitTypeId = unitType.body.id as string;

    const u1 = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId,
      unitTypeId,
      code: 'BM-001',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 80,
    });
    expect(u1.status).toBe(201);
    await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId,
      unitTypeId,
      code: 'BM-002',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });

    const res = await request(app.getHttpServer()).get('/analytics/benchmark').set(auth);
    expect(res.status).toBe(200);
    // `available` boolean + `sampleSize` numérico siempre presentes.
    expect(typeof res.body.available).toBe('boolean');
    expect(typeof res.body.sampleSize).toBe('number');

    if (res.body.available === true) {
      // Si por casualidad la BD tuviera ≥5 operadores con trasteros, validamos
      // que sólo se exponen agregados anónimos + los valores propios.
      expect(res.body.sampleSize).toBeGreaterThanOrEqual(5);
      for (const metric of [res.body.occupancy, res.body.price].filter(Boolean)) {
        expect(typeof metric.median).toBe('number');
        expect(typeof metric.p25).toBe('number');
        expect(typeof metric.p75).toBe('number');
        expect(typeof metric.mine).toBe('number');
        expect(metric.myPercentile).toBeGreaterThanOrEqual(0);
        expect(metric.myPercentile).toBeLessThanOrEqual(100);
      }
    } else {
      // Caso esperado en una BD de test recién limpiada (< 5 operadores):
      // muestra insuficiente → sin agregados (protege el anonimato).
      expect(res.body.available).toBe(false);
      expect(res.body.occupancy).toBeUndefined();
      expect(res.body.price).toBeUndefined();
      expect(res.body.pricePerSqm).toBeUndefined();
    }
  });

  it('401 sin token', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/benchmark');
    expect(res.status).toBe(401);
  });
});
