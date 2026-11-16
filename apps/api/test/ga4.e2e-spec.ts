import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  withAdminDb,
} from './helpers/tenant-fixtures';
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
  /** ID de medición de la web del tenant (Configuración → Marca y SEO). */
  const setMeasurementId = (slug: string, id: string | null) =>
    withAdminDb((db) => db.tenant.update({ where: { slug }, data: { googleAnalyticsId: id } }));

  it('conectar la propiedad, descargar y resumir; sin acceso o sin Web Premium no', async () => {
    const owner = await registerVerifiedUser(app, 'ga4-web');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Dentro de Web Premium (ver la conexión y desconectar, sin él también).
    await http().get('/marketing/ga4/report').set(auth).expect(403);
    await http().put('/marketing/ga4').set(auth).send({ propertyId: '123456789' }).expect(403);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const initial = (await http().get('/marketing/ga4').set(auth).expect(200))
      .body as Ga4SettingsDto;
    expect(initial).toMatchObject({ available: true, propertyId: null, status: null });
    expect(initial.serviceAccountEmail).toContain('@');

    // El ID de medición (G-…) no es el de la propiedad.
    await http().put('/marketing/ga4').set(auth).send({ propertyId: 'G-ABC123' }).expect(400);

    // Sin el ID de medición de su web no se puede comprobar que la propiedad es suya.
    const noId = await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: 'properties/123456789' })
      .expect(400);
    expect(noId.body.code).toBe('ga4_measurement_id_required');

    // Una propiedad que no mide su web (simulado: la propiedad N mide G-N).
    await setMeasurementId(owner.slug, 'G-999999');
    const mismatch = await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: '123456789' })
      .expect(400);
    expect(mismatch.body.code).toBe('ga4_property_mismatch');

    // Sin acceso: el motivo vuelve en la respuesta y no se guarda nada.
    const denied = await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: '403403403' })
      .expect(400);
    expect(denied.body.code).toBe('ga4_no_access');
    expect(denied.body.message).toContain('Lector');
    const afterDenied = (await http().get('/marketing/ga4').set(auth)).body as Ga4SettingsDto;
    expect(afterDenied).toMatchObject({ propertyId: null, status: null });

    // Con acceso y midiendo su web: se descargan los últimos meses.
    await setMeasurementId(owner.slug, 'G-123456789');
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
    // Las firmas llegan sin su enlace secreto, juntas.
    expect(report.pages.find((p) => p.path === '/sign/enlace')).toMatchObject({ pageViews: 14 });
    expect(report.pages.some((p) => p.path.includes('tok-'))).toBe(false);
    expect(report.daily).toHaveLength(7);

    // Volver a descargar no duplica.
    await http().post('/marketing/ga4/sync').set(auth).expect(201);
    const again = (await http().get('/marketing/ga4/report?days=7').set(auth)).body as Ga4ReportDto;
    expect(again.totals.sessions).toBe(63);

    // Otro tenant no ve nada.
    const other = await registerVerifiedUser(app, 'ga4-web-b');
    await setTenantFeatureOverride(other.slug, 'web_premium', true);
    // Ni puede conectar la propiedad de este, aunque ponga su ID de medición.
    await setMeasurementId(other.slug, 'G-123456789');
    const taken = await http()
      .put('/marketing/ga4')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send({ propertyId: '123456789' })
      .expect(409);
    expect(taken.body.code).toBe('ga4_property_taken');
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

  it('una conexión de antes, si la propiedad no mide la web del negocio, deja de descargar', async () => {
    const owner = await registerVerifiedUser(app, 'ga4-legacy');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await setMeasurementId(owner.slug, 'G-111111');
    await withAdminDb(async (db) => {
      const t = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
      await db.tenantGa4.create({
        data: { tenantId: t.id, propertyId: '424242', status: 'connected' },
      });
    });
    await http().post('/marketing/ga4/sync').set(auth).expect(201);
    const after = (await http().get('/marketing/ga4').set(auth)).body as Ga4SettingsDto;
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('no mide tu web');
    const report = (await http().get('/marketing/ga4/report?days=7').set(auth))
      .body as Ga4ReportDto;
    expect(report.totals.sessions).toBe(0);

    // Con el ID de medición correcto, la siguiente descarga la da por buena.
    await setMeasurementId(owner.slug, 'G-424242');
    await http().post('/marketing/ga4/sync').set(auth).expect(201);
    const fixed = (await http().get('/marketing/ga4').set(auth)).body as Ga4SettingsDto;
    expect(fixed).toMatchObject({ status: 'connected', lastError: null });
  });

  it('exige sesión', async () => {
    await http().get('/marketing/ga4/report').expect(401);
  });
});
