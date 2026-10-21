import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Ga4ReportDto, Ga4SettingsDto } from '@storageos/shared';

describe('Google Analytics 4 de la web (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  it('conectar la propiedad, descargar y resumir; sin acceso o sin Web Premium no', async () => {
    const owner = await registerVerifiedUser(app, 'ga4-web');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Dentro de Web Premium.
    await http().get('/marketing/ga4').set(auth).expect(403);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const initial = (await http().get('/marketing/ga4').set(auth).expect(200))
      .body as Ga4SettingsDto;
    expect(initial).toMatchObject({ available: true, propertyId: null, status: null });
    expect(initial.serviceAccountEmail).toContain('@');

    // El ID de medición (G-…) no es el de la propiedad.
    await http().put('/marketing/ga4').set(auth).send({ propertyId: 'G-ABC123' }).expect(400);

    // Sin acceso: queda guardada con el error para que el tenant lo corrija.
    const denied = await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: '403403403' })
      .expect(400);
    expect(denied.body.code).toBe('ga4_no_access');
    const afterDenied = (await http().get('/marketing/ga4').set(auth)).body as Ga4SettingsDto;
    expect(afterDenied).toMatchObject({ propertyId: '403403403', status: 'error' });
    expect(afterDenied.lastError).toContain('Lector');

    // Con acceso: se descargan los últimos meses.
    const ok = await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: 'properties/123456789' })
      .expect(200);
    expect(ok.body).toMatchObject({
      propertyId: '123456789',
      status: 'connected',
      lastError: null,
    });
    expect(ok.body.lastSyncedAt).toBeTruthy();

    const report = (await http().get('/marketing/ga4/report?days=7').set(auth).expect(200))
      .body as Ga4ReportDto;
    // Simulado: 6 sesiones de Google y 3 de Instagram cada día.
    expect(report.totals.sessions).toBe(63);
    expect(report.previous.sessions).toBe(63);
    expect(report.totals.keyEvents).toBe(7);
    expect(report.totals.engagementRate).toBeCloseTo(35 / 63, 3);
    expect(report.sources.map((s) => [s.source, s.medium, s.sessions])).toEqual([
      ['google', 'organic', 42],
      ['instagram', 'social', 21],
    ]);
    expect(report.pages[0]).toMatchObject({ path: '/', pageViews: 84 });
    expect(report.daily).toHaveLength(7);

    // Volver a descargar no duplica.
    await http().post('/marketing/ga4/sync').set(auth).expect(201);
    const again = (await http().get('/marketing/ga4/report?days=7').set(auth)).body as Ga4ReportDto;
    expect(again.totals.sessions).toBe(63);

    // Otro tenant no ve nada.
    const other = await registerVerifiedUser(app, 'ga4-web-b');
    await setTenantFeatureOverride(other.slug, 'web_premium', true);
    const otherReport = (
      await http()
        .get('/marketing/ga4/report')
        .set({ Authorization: `Bearer ${other.accessToken}` })
        .expect(200)
    ).body as Ga4ReportDto;
    expect(otherReport.totals.sessions).toBe(0);

    // Desconectar borra los datos.
    const off = await http().delete('/marketing/ga4').set(auth).expect(200);
    expect(off.body).toMatchObject({ propertyId: null, status: null });
    const empty = (await http().get('/marketing/ga4/report').set(auth)).body as Ga4ReportDto;
    expect(empty.totals.sessions).toBe(0);
  });

  it('exige sesión', async () => {
    await http().get('/marketing/ga4/report').expect(401);
  });
});
