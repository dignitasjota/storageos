import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const GOOGLE_URL = 'https://g.page/r/trasteros-demo/review';

describe('Google reviews (promotor → CTA) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function requestReviewToken(
    auth: Record<string, string>,
    customerId: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, channel: 'email' });
    expect(res.status).toBe(201);
    return (res.body.reviewUrl as string).split('/review/')[1]!;
  }

  it('devuelve el link de Google al promotor (NPS≥9) y no al detractor', async () => {
    const owner = await registerVerifiedUser(app, 'greviews');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Configurar el link de Google.
    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/reviews')
      .set(auth)
      .send({ googleReviewUrl: GOOGLE_URL });
    expect(patch.status).toBe(200);
    expect(patch.body.googleReviewUrl).toBe(GOOGLE_URL);

    const get = await request(app.getHttpServer()).get('/settings/tenant/reviews').set(auth);
    expect(get.body.googleReviewUrl).toBe(GOOGLE_URL);

    const customerId = await createCustomer(app, owner.accessToken);

    // Promotor (NPS 10) → recibe el link de Google.
    const tokenPromoter = await requestReviewToken(auth, customerId);
    const promoter = await request(app.getHttpServer())
      .post(`/public/reviews/${tokenPromoter}`)
      .send({ npsScore: 10, rating: 5 });
    expect(promoter.status).toBe(201);
    expect(promoter.body.status).toBe('submitted');
    expect(promoter.body.googleReviewUrl).toBe(GOOGLE_URL);

    // Detractor (NPS 3) → sin link (se gestiona en privado).
    const tokenDetractor = await requestReviewToken(auth, customerId);
    const detractor = await request(app.getHttpServer())
      .post(`/public/reviews/${tokenDetractor}`)
      .send({ npsScore: 3, comment: 'No del todo contento' });
    expect(detractor.status).toBe(201);
    expect(detractor.body.googleReviewUrl).toBeNull();
  });
});
