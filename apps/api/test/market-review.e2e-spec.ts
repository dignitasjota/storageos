import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { GoogleApiError } from '../src/common/google/google-service-account';
import { SearchConsoleClient } from '../src/modules/search-console/search-console.client';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Mercado: ocupación como en Analítica y la de la competencia solo
 * con inventario completo, cualquier comprobación cuenta como revisión, precios
 * mayores que 0, medidas que se quitan, competidores del local de otro negocio;
 * y en Posiciones en Google, totales de Google, periodo anterior incompleto,
 * fallos pasajeros que no ocultan los datos y el informe a quien lo pide.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Revisión de Mercado (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('competencia: ocupación, revisión, precios, medidas y locales de otro negocio', async () => {
    const owner = await registerVerifiedUser(app, 'mkrcomp');
    const other = await registerVerifiedUser(app, 'mkrother');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mine = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 4 });
    const soon = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 4 });
    const foreign = await createFacilityWithUnits(app, other.accessToken, { unitsCount: 1 });
    await db.facility.update({ where: { id: soon.facilityId }, data: { preOpening: true } });
    await db.unit.update({ where: { id: mine.unitIds[0]! }, data: { status: 'occupied' } });

    // Un local de otro negocio no se puede ligar.
    const bad = await http()
      .post('/competitors')
      .set(auth)
      .send({ name: 'X', facilityId: foreign.facilityId });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_facility');

    const complete = await http()
      .post('/competitors')
      .set(auth)
      .send({ name: 'Completo', facilityId: mine.facilityId, inventoryComplete: true })
      .expect(201);
    const estimated = await http()
      .post('/competitors')
      .set(auth)
      .send({ name: 'Estimado', knownTotalUnits: 40 })
      .expect(201);

    // Precio 0: no.
    await http()
      .post(`/competitors/${complete.body.id}/units`)
      .set(auth)
      .send({ areaM2: 5, priceMonthly: 0 })
      .expect(400);
    const u1 = await http()
      .post(`/competitors/${complete.body.id}/units`)
      .set(auth)
      .send({ widthM: 2, depthM: 3, priceMonthly: 80, status: 'occupied' })
      .expect(201);
    await http()
      .post(`/competitors/${complete.body.id}/units`)
      .set(auth)
      .send({ areaM2: 4, priceMonthly: 60, status: 'available' })
      .expect(201);
    await http()
      .post(`/competitors/${estimated.body.id}/units`)
      .set(auth)
      .send({ areaM2: 7, priceMonthly: 70, status: 'available' })
      .expect(201);

    // Fichar trasteros cuenta como comprobación: no sale como «sin revisar».
    const alerts = await http().get('/analytics/competition-alerts').set(auth).expect(200);
    expect(alerts.body.stale).toEqual([]);
    const list = await http().get('/competitors').set(auth).expect(200);
    expect(
      list.body.find((c: { id: string }) => c.id === complete.body.id).lastReviewedAt,
    ).not.toBeNull();

    // Ocupación: la mía como en Analítica; la del mercado, solo inventario completo.
    const market = await http().get('/competitors/occupancy').set(auth).expect(200);
    const analytics = await http().get('/analytics/occupancy').set(auth).expect(200);
    expect(market.body.myTotalUnits).toBe(analytics.body.totalUnits);
    expect(market.body.myOccupancyPct).toBeCloseTo(analytics.body.physicalOccupancy);
    expect(market.body.competitionTotalUnits).toBe(2);
    expect(market.body.competitionOccupancyPct).toBeCloseTo(0.5);
    const est = market.body.competitors.find((c: { id: string }) => c.id === estimated.body.id);
    expect(est).toMatchObject({ occupancyPct: null });
    expect(est.estimatedOccupancyPct).toBeCloseTo(39 / 40);

    // Corregir la referencia no la da por comprobada; «lo he comprobado hoy» sí.
    const before = await db.competitorUnit.findUniqueOrThrow({ where: { id: u1.body.id } });
    await db.competitorUnit.update({
      where: { id: u1.body.id },
      data: { lastCheckedAt: new Date('2026-01-01T00:00:00Z') },
    });
    const ref = await http()
      .patch(`/competitors/units/${u1.body.id}`)
      .set(auth)
      .send({ externalRef: 'A-1', priceMonthly: 80, status: 'occupied' })
      .expect(200);
    expect(ref.body.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(ref.body.history.observations).toBe(1);
    const checked = await http()
      .patch(`/competitors/units/${u1.body.id}`)
      .set(auth)
      .send({ checked: true })
      .expect(200);
    expect(checked.body.history.observations).toBe(2);
    expect(new Date(checked.body.lastCheckedAt).getTime()).toBeGreaterThan(
      before.createdAt.getTime() - 1,
    );

    // Quitar las medidas.
    const noDims = await http()
      .patch(`/competitors/units/${u1.body.id}`)
      .set(auth)
      .send({ widthM: null, depthM: null, areaM2: 6.5 })
      .expect(200);
    expect(noDims.body).toMatchObject({ widthM: null, depthM: null, areaM2: 6.5 });

    // Revisión con un precio de 0: no.
    await http()
      .post(`/competitors/${complete.body.id}/review`)
      .set(auth)
      .send({ units: [{ id: u1.body.id, priceMonthly: 0, status: 'occupied' }] })
      .expect(400);

    // Todo queda en el registro de actividad.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const logs = await db.auditLog.findMany({
      where: { tenantId: tenant.id, action: { startsWith: 'competitor.' } },
      select: { action: true },
    });
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining([
        'competitor.created',
        'competitor.unit_created',
        'competitor.unit_updated',
      ]),
    );
  });

  it('posiciones en Google: totales, periodo incompleto, fallos pasajeros e informe', async () => {
    const owner = await registerVerifiedUser(app, 'mkrseo');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);
    await setVerifiedCustomDomain(owner.slug, `www.${owner.slug}.es`);

    // Sin conectar, el informe no se envía.
    await http().post('/seo/report/send').set(auth).expect(400);

    await http()
      .put('/seo/search-console')
      .set(auth)
      .send({ siteUrl: `sc-domain:${owner.slug}.es` })
      .expect(200);

    // Totales de Google (con las búsquedas que no detalla): más que la suma.
    const pos = await http().get('/seo/positions?days=28').set(auth).expect(200);
    const sumClicks = (pos.body.queries as { clicks: number }[]).reduce((s, q) => s + q.clicks, 0);
    expect(pos.body.totals.clicks).toBeGreaterThan(sumClicks);
    expect(pos.body.previousComplete).toBe(true);

    // Si se descargaron menos días de los que pide la comparación, se dice.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const cut = new Date(Date.now() - 120 * 86_400_000);
    await db.searchConsoleRow.deleteMany({ where: { tenantId: tenant.id, date: { lt: cut } } });
    await db.searchConsoleDay.deleteMany({ where: { tenantId: tenant.id, date: { lt: cut } } });
    const pos90 = await http().get('/seo/positions?days=90').set(auth).expect(200);
    expect(pos90.body.previousComplete).toBe(false);
    expect(pos90.body.alerts).toEqual([]);

    // Un fallo de Google no es «sin acceso»: los datos siguen a la vista.
    const client = app.get(SearchConsoleClient);
    const spy = jest
      .spyOn(client, 'searchAnalytics')
      .mockRejectedValueOnce(new GoogleApiError('Backend Error', 503));
    const sync = await http().post('/seo/search-console/sync').set(auth);
    expect(sync.status).toBe(502);
    const after = await http().get('/seo/search-console').set(auth).expect(200);
    expect(after.body.status).toBe('connected');
    expect(after.body.lastError).toContain('Se reintentará');
    // Sin permiso, sí.
    spy.mockRejectedValueOnce(new GoogleApiError('User does not have sufficient permission', 403));
    await http().post('/seo/search-console/sync').set(auth).expect(502);
    expect((await http().get('/seo/search-console').set(auth)).body.status).toBe('error');
    spy.mockRestore();

    // «Enviármelo ahora» va solo a quien lo pide y no marca el mes como enviado.
    const sent = await http().post('/seo/report/send').set(auth).expect(201);
    expect(sent.body.recipients).toBe(1);
    const row = await db.tenantSearchConsole.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(row.lastReportMonth).toBeNull();
  });
});
