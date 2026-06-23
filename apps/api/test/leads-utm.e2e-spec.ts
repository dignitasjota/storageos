import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Tracking UTM en leads (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el widget guarda los utm_* y el reporte agrega por origen/campaña', async () => {
    const owner = await registerVerifiedUser(app, 'leadutm');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Lead desde el widget con UTM (como llegaría de una campaña).
    const lead = await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Ana',
        email: `utm-${Date.now()}@e2e.local`,
        phone: '600111222',
        acceptsTerms: true,
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'verano2026',
      });
    expect(lead.status).toBe(201);
    expect(lead.body.utmSource).toBe('google');
    expect(lead.body.utmCampaign).toBe('verano2026');

    // El reporte agrega ese lead por (origen, campaña).
    const report = await request(app.getHttpServer()).get('/analytics/leads-utm').set(auth);
    expect(report.status).toBe(200);
    expect(report.body.totalTracked).toBeGreaterThanOrEqual(1);
    const row = report.body.rows.find(
      (r: { source: string; campaign: string }) =>
        r.source === 'google' && r.campaign === 'verano2026',
    );
    expect(row).toBeDefined();
    expect(row.total).toBe(1);
    expect(row.won).toBe(0);
    expect(row.conversionRate).toBe(0);
  });

  it('un lead sin UTM no aparece en el reporte de campañas', async () => {
    const owner = await registerVerifiedUser(app, 'leadnoutm');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Sin',
        email: `noutm-${Date.now()}@e2e.local`,
        phone: '600333444',
        acceptsTerms: true,
      })
      .expect(201);

    const report = await request(app.getHttpServer()).get('/analytics/leads-utm').set(auth);
    expect(report.body.rows).toHaveLength(0);
    expect(report.body.totalTracked).toBe(0);
  });
});
