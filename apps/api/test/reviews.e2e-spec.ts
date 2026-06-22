import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function tokenFromUrl(url: string): string {
  return url.split('/review/')[1] ?? '';
}

describe('Reviews / NPS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function createCustomer(token: string, email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerType: 'individual',
        firstName: 'Nps',
        lastName: 'Tester',
        email,
        country: 'ES',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('flujo completo: request → contexto público → submit → stats', async () => {
    const owner = await registerVerifiedUser(app, 'reviews-flow');
    const customerId = await createCustomer(owner.accessToken, 'reviews-flow@e2e.local');

    // Solicitar valoración
    const reqRes = await request(app.getHttpServer())
      .post('/reviews/request')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId, channel: 'email' });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.reviewUrl).toContain('/review/');
    const token = tokenFromUrl(reqRes.body.reviewUrl);
    expect(token.length).toBeGreaterThan(10);

    // Contexto público (sin auth)
    const ctx = await request(app.getHttpServer()).get(`/public/reviews/${token}`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.status).toBe('pending');
    expect(typeof ctx.body.tenantName).toBe('string');

    // Enviar valoración
    const submit = await request(app.getHttpServer())
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 10, rating: 5, comment: 'Excelente' });
    expect(submit.status).toBe(201);
    expect(submit.body.status).toBe('submitted');

    // Reenviar: ya no admite respuesta
    const resubmit = await request(app.getHttpServer())
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 0 });
    expect(resubmit.status).toBe(404);
    expect(resubmit.body.code).toBe('review_not_pending');

    // Stats: 1 enviada, promotor, NPS 100
    const stats = await request(app.getHttpServer())
      .get('/reviews/stats')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.submitted).toBe(1);
    expect(stats.body.promoters).toBe(1);
    expect(stats.body.npsScore).toBe(100);
    expect(stats.body.avgRating).toBe(5);

    // Lista
    const list = await request(app.getHttpServer())
      .get('/reviews')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].npsScore).toBe(10);
    expect(list.body.items[0].status).toBe('submitted');
  });

  it('valida el rango del NPS (422/400 si fuera de 0-10)', async () => {
    const owner = await registerVerifiedUser(app, 'reviews-validation');
    const customerId = await createCustomer(owner.accessToken, 'reviews-val@e2e.local');
    const reqRes = await request(app.getHttpServer())
      .post('/reviews/request')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId });
    const token = tokenFromUrl(reqRes.body.reviewUrl);

    const bad = await request(app.getHttpServer())
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 11 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it('token inválido → 404', async () => {
    const res = await request(app.getHttpServer()).get('/public/reviews/no-existe-token');
    expect(res.status).toBe(404);
  });

  it('ajustes de auto-solicitud: GET default OFF, PATCH activa', async () => {
    const owner = await registerVerifiedUser(app, 'reviews-settings');
    const get = await request(app.getHttpServer())
      .get('/settings/tenant/reviews')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ reviewsAutoRequest: false, reviewRequestDelayDays: 14 });

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/reviews')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reviewsAutoRequest: true, reviewRequestDelayDays: 7 });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ reviewsAutoRequest: true, reviewRequestDelayDays: 7 });
  });
});
