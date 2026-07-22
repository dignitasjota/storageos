import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Alta MANUAL de leads (contacto de Idealista / llamada / visita) con **origen
 * propio creable al vuelo**: el origen es texto libre normalizado, entra en el
 * mismo pipeline kanban que los leads de la web.
 */
describe('Leads manuales + origen libre (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('crea un lead con origen sugerido y otro con origen propio (normalizado)', async () => {
    const owner = await registerVerifiedUser(app, 'lead-manual');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Origen sugerido (Idealista).
    const a = await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ source: 'idealista', firstName: 'Ana', phone: '600111222' });
    expect(a.status).toBe(201);
    expect(a.body.source).toBe('idealista');
    expect(a.body.status).toBe('new');

    // Origen propio escrito a mano → se normaliza a clave estable.
    const b = await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ source: 'Habitaclia Pro', firstName: 'Luis' });
    expect(b.status).toBe(201);
    expect(b.body.source).toBe('habitaclia_pro');

    // El origen propio reaparece en el catálogo de orígenes disponibles.
    const sources = await request(app.getHttpServer()).get('/leads/sources').set(auth);
    expect(sources.status).toBe(200);
    const values = (sources.body as { value: string }[]).map((s) => s.value);
    expect(values).toContain('portal_inmobiliario'); // sugerido
    expect(values).toContain('habitaclia_pro'); // propio, dado de alta al vuelo

    // Sigue el pipeline como cualquier lead: mover a «contactado».
    const moved = await request(app.getHttpServer())
      .post(`/leads/${a.body.id}/transition`)
      .set(auth)
      .send({ status: 'contacted' });
    expect(moved.status).toBe(201);
    expect(moved.body.status).toBe('contacted');
  });

  it('exige autenticación', async () => {
    await request(app.getHttpServer())
      .post('/leads')
      .send({ source: 'idealista', firstName: 'X' })
      .expect(401);
  });
});
