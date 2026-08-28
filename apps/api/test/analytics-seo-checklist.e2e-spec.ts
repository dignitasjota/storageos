import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Analytics — checklist de SEO on-page (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('requiere autenticación', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/seo-checklist');
    expect(res.status).toBe(401);
  });

  it('tenant vacío: todo pendiente, sin web_premium', async () => {
    const owner = await registerVerifiedUser(app, 'seo-checklist-empty');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const res = await request(app.getHttpServer()).get('/analytics/seo-checklist').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.hasWebPremium).toBe(false);
    expect(res.body.base).toHaveLength(5);
    expect(res.body.premium).toHaveLength(5);
    expect(res.body.base.every((i: { done: boolean }) => !i.done)).toBe(true);
    expect(res.body.premium.every((i: { done: boolean }) => !i.done)).toBe(true);
    expect(res.body.baseScore).toEqual({ done: 0, total: 5 });
    expect(res.body.premiumScore).toEqual({ done: 0, total: 5 });
    const openingHours = res.body.base.find((i: { id: string }) => i.id === 'opening_hours');
    expect(openingHours.detail).toBe('Añade tu primer local');
  });

  it('completar los 5 checks base sube el score a 5/5', async () => {
    const owner = await registerVerifiedUser(app, 'seo-checklist-base');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });

    // Horario + dirección + teléfono.
    await request(app.getHttpServer())
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({
        openingHours: { mon: { open: '09:00', close: '20:00' } },
        address: 'Calle Falsa 123',
        contactPhone: '600111222',
      })
      .expect(200);

    // Imagen (no hace falta subirla físicamente, solo confirmar la key).
    const presign = await request(app.getHttpServer())
      .post(`/facilities/${facilityId}/images/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/jpeg', sizeBytes: 1000 });
    await request(app.getHttpServer())
      .put(`/facilities/${facilityId}/images`)
      .set(auth)
      .send({ images: [presign.body.key] })
      .expect(200);

    // Enlace de reseñas de Google.
    await request(app.getHttpServer())
      .patch('/settings/tenant/reviews')
      .set(auth)
      .send({ googleReviewUrl: 'https://g.page/r/test/review' })
      .expect(200);

    const res = await request(app.getHttpServer()).get('/analytics/seo-checklist').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.baseScore).toEqual({ done: 5, total: 5 });
    expect(res.body.base.every((i: { done: boolean }) => i.done)).toBe(true);
  });

  it('con web_premium: completar los 5 checks premium sube el score a 5/5', async () => {
    const owner = await registerVerifiedUser(app, 'seo-checklist-premium');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    // Titular propio + secciones de testimonios/contacto activas.
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set(auth)
      .send({
        headline: 'Trasteros en el centro de la ciudad',
        sections: { testimonials: true, contact: true },
      })
      .expect(200);

    // FAQ publicada.
    await request(app.getHttpServer())
      .post('/faq-entries')
      .set(auth)
      .send({ question: '¿Hay acceso 24h?', answer: 'Sí, con tu PIN.', position: 0 })
      .expect(201);

    // Reseña promotora (NPS≥9 con comentario) para alimentar los testimonios.
    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Nps',
      lastName: 'Tester',
      email: 'seo-checklist-nps@e2e.local',
      country: 'ES',
    });
    const reviewReq = await request(app.getHttpServer())
      .post('/reviews/request')
      .set(auth)
      .send({ customerId: customer.body.id, channel: 'email' });
    const token = (reviewReq.body.reviewUrl as string).split('/review/')[1] ?? '';
    await request(app.getHttpServer())
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 10, rating: 5, comment: 'Excelente servicio' })
      .expect(201);

    // Entrada de blog publicada.
    await request(app.getHttpServer())
      .post('/blog-posts')
      .set(auth)
      .send({
        title: 'Cómo elegir tamaño de trastero',
        contentMarkdown: 'Contenido.',
        isPublished: true,
      })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/analytics/seo-checklist').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.hasWebPremium).toBe(true);
    expect(res.body.premiumScore).toEqual({ done: 5, total: 5 });
    expect(res.body.premium.every((i: { done: boolean }) => i.done)).toBe(true);
  });
});
