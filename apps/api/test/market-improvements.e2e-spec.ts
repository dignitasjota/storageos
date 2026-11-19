import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SearchConsoleService } from '../src/modules/search-console/search-console.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setTenantPlan,
  setVerifiedCustomDomain,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Mercado: precio comparable, tu precio frente al mercado,
 * promociones con fin e histórico, alta en bloque, lectura de tarifas con IA,
 * evolución, exportación y avisos; y en Posiciones en Google, semanas, marca,
 * dispositivos, búsquedas que se siguen, detalle, de Google a reservas, el
 * informe a quien se elija y el aviso de caídas.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Mejoras de Mercado (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('competencia: precio comparable, mapa de precios, promociones, bloque, IA y avisos', async () => {
    const owner = await registerVerifiedUser(app, 'mkicomp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mine = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await db.unit.updateMany({
      where: { id: { in: mine.unitIds } },
      data: { widthM: 2, depthM: 2.5 },
    });

    // Precio con IVA y un mes gratis que ya terminó: no cuenta.
    const comp = await http()
      .post('/competitors')
      .set(auth)
      .send({
        name: 'Rival',
        facilityId: mine.facilityId,
        priceIncludesVat: true,
        inventoryComplete: true,
        promoFreeMonths: 1,
        promoEndsAt: '2020-01-01',
        reviewEveryDays: 7,
      })
      .expect(201);
    expect(comp.body).toMatchObject({ promotionActive: false, reviewEveryDays: 7 });

    // Alta en bloque.
    const bulk = await http()
      .post(`/competitors/${comp.body.id}/units/bulk`)
      .set(auth)
      .send({
        units: [
          { areaM2: 5, priceMonthly: 72.6, status: 'occupied' },
          { areaM2: 9, priceMonthly: 121, status: 'occupied' },
        ],
      })
      .expect(201);
    expect(bulk.body).toHaveLength(2);
    const five = bulk.body.find((u: { areaM2: number }) => u.areaM2 === 5);
    // 72,60 con IVA = 60 sin IVA; la promoción ya terminó.
    expect(five.comparablePrice).toBe(60);
    expect(five.comparablePerM2).toBe(12);

    // Tu precio frente al mercado: 50 frente a 60, un 16,7 % por debajo.
    const map = await http().get('/competitors/price-map').set(auth).expect(200);
    const row = map.body.rows.find((r: { unitTypeId: string }) => r.unitTypeId === mine.unitTypeId);
    expect(row).toMatchObject({ myPrice: 50, marketMedian: 60, samples: 1 });
    expect(row.gapPct).toBeCloseTo(-16.7, 1);
    expect(map.body.points.length).toBeGreaterThanOrEqual(3);

    // Cambiar la promoción la guarda en el histórico.
    await http()
      .patch(`/competitors/${comp.body.id}`)
      .set(auth)
      .send({ currentPromotion: '2x1 en verano', promoFreeMonths: null, promoEndsAt: null })
      .expect(200);
    const promos = await http()
      .get(`/competitors/${comp.body.id}/promotions`)
      .set(auth)
      .expect(200);
    expect(promos.body).toHaveLength(2);
    expect(promos.body[0]).toMatchObject({ description: '2x1 en verano', endedAt: null });
    expect(promos.body[1].endedAt).not.toBeNull();

    // Agotado el tamaño que tú tienes libre: aviso.
    const alerts = await http().get('/analytics/competition-alerts').set(auth).expect(200);
    expect(alerts.body.soldOut).toEqual([
      expect.objectContaining({ competitorFacilityId: comp.body.id, myAvailable: 2 }),
    ]);

    // Sube un precio donde eres más barato: aviso de margen.
    await http()
      .patch(`/competitors/units/${five.id}`)
      .set(auth)
      .send({ priceMonthly: 84.7 })
      .expect(200);
    const after = await http().get('/analytics/competition-alerts').set(auth).expect(200);
    expect(after.body.priceRises).toEqual([
      expect.objectContaining({ competitorUnitId: five.id, newPrice: 84.7, myPrice: 50 }),
    ]);

    // Evolución mensual y exportación.
    const trend = await http().get(`/competitors/${comp.body.id}/trend`).set(auth).expect(200);
    expect(trend.body.points).toHaveLength(12);
    const last = trend.body.points[trend.body.points.length - 1];
    expect(last.occupancy).toBe(1);
    expect(last.avgComparablePrice).toBeGreaterThan(0);
    const exp = await http().get('/competitors/export').set(auth).expect(200);
    expect(exp.body).toHaveLength(2);
    expect(exp.body[0]).toMatchObject({ competitorName: 'Rival', priceIncludesVat: true });

    // Leer su web con IA: sin el asistente en el plan, no.
    await http()
      .post(`/competitors/${comp.body.id}/ai-parse`)
      .set(auth)
      .send({ text: 'Trastero 2x2 a 59 euros al mes. Trastero de 9 m² 119 €, agotado.' })
      .expect(403);
    await setTenantPlan(owner.slug, 'pro');
    const parsed = await http()
      .post(`/competitors/${comp.body.id}/ai-parse`)
      .set(auth)
      .send({ text: 'Trastero 2x2 a 59 euros al mes. Trastero de 9 m² 119 €, agotado.' })
      .expect(200);
    expect(parsed.body.units).toHaveLength(2);
    expect(parsed.body.units[0]).toMatchObject({ areaM2: 4, priceMonthly: 59, matchUnitId: null });
    // El de 9 m² ya está fichado: se propone actualizarlo.
    const nine = bulk.body.find((u: { areaM2: number }) => u.areaM2 === 9);
    expect(parsed.body.units[1]).toMatchObject({ areaM2: 9, matchUnitId: nine.id });
    expect(parsed.body.notes).toBeTruthy();
  });

  it('posiciones en Google: semanas, marca, dispositivos, seguimiento, detalle y embudo', async () => {
    const owner = await registerVerifiedUser(app, 'mkiseo');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);
    await setVerifiedCustomDomain(owner.slug, `www.${owner.slug}.es`);
    await http()
      .put('/seo/search-console')
      .set(auth)
      .send({ siteUrl: `sc-domain:${owner.slug}.es` })
      .expect(200);

    // Al conectar, 16 meses de totales: el año pasado se puede comparar.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    expect(
      await db.searchConsoleDay.count({ where: { tenantId: tenant.id } }),
    ).toBeGreaterThanOrEqual(470);

    await http()
      .patch('/seo/search-console/settings')
      .set(auth)
      .send({ brandTerms: ['Mislata'] })
      .expect(200);
    const pos = await http().get('/seo/positions?days=28').set(auth).expect(200);
    expect(pos.body.weekly.length).toBeGreaterThanOrEqual(4);
    expect(pos.body.brand.terms).toEqual(['mislata']);
    expect(pos.body.brand.brandClicks).toBeGreaterThan(0);
    expect(pos.body.brand.genericClicks).toBeGreaterThan(0);
    expect(pos.body.devices.map((d: { device: string }) => d.device)).toEqual([
      'MOBILE',
      'DESKTOP',
    ]);
    expect(pos.body.yearAgoTotals).not.toBeNull();

    // Búsquedas que se siguen.
    await http()
      .post('/seo/keywords')
      .set(auth)
      .send({ keyword: 'Trasteros cerca de mi', targetPosition: 3 })
      .expect(204);
    await http()
      .post('/seo/keywords')
      .set(auth)
      .send({ keyword: 'trasteros cerca de mi' })
      .expect(409);
    const kw = await http().get('/seo/keywords').set(auth).expect(200);
    expect(kw.body[0]).toMatchObject({ position: 6.5, targetPosition: 3, reached: false });
    expect(kw.body[0].clicks).toBeGreaterThan(0);

    // Detalle de una búsqueda.
    const detail = await http()
      .get('/seo/detail')
      .query({ query: 'trasteros cerca de mi' })
      .set(auth)
      .expect(200);
    expect(detail.body.daily.length).toBeGreaterThan(20);
    expect(detail.body.related[0].label).toContain(owner.slug);
    await http().get('/seo/detail').set(auth).expect(400);

    // De Google a reservas: un visitante y un contacto desde Google.
    await db.webEvent.create({
      data: {
        tenantId: tenant.id,
        visitorId: 'v-google-1',
        kind: 'page_view',
        path: '/trasteros-en-mislata',
        source: 'google',
        medium: 'organic',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    await db.lead.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Lucía',
        email: `mki-${Date.now()}@e2e.local`,
        source: 'web',
        utmSource: 'google',
        utmMedium: 'organic',
        status: 'won',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const funnel = await http().get('/seo/google-funnel').set(auth).expect(200);
    expect(funnel.body).toMatchObject({ visitors: 1, contacts: 1, bookings: 1 });
    expect(funnel.body.googleClicks).toBeGreaterThan(0);
    expect(funnel.body.pages[0]).toMatchObject({ path: '/trasteros-en-mislata', visitors: 1 });

    // El informe a quien se elija; alguien de otro negocio, no.
    const other = await registerVerifiedUser(app, 'mkiother');
    const otherUser = await db.user.findFirstOrThrow({ where: { email: other.email } });
    await http()
      .patch('/seo/search-console/settings')
      .set(auth)
      .send({ reportRecipientIds: [otherUser.id] })
      .expect(400);
    const me = await db.user.findFirstOrThrow({ where: { email: owner.email } });
    const set = await http()
      .patch('/seo/search-console/settings')
      .set(auth)
      .send({ reportRecipientIds: [me.id] })
      .expect(200);
    expect(set.body.reportRecipientIds).toEqual([me.id]);

    // Caída de clics: aviso una vez por semana.
    const days = await db.searchConsoleDay.findMany({
      where: { tenantId: tenant.id },
      orderBy: { date: 'desc' },
      take: 7,
    });
    await db.searchConsoleDay.updateMany({
      where: { id: { in: days.map((d) => d.id) } },
      data: { clicks: 0 },
    });
    const gsc = app.get(SearchConsoleService);
    expect(await gsc.checkDrop(tenant.id)).toBe(true);
    expect(await gsc.checkDrop(tenant.id)).toBe(false);
    const note = await db.notification.findFirst({
      where: { tenantId: tenant.id, type: 'seo.clicks_drop' },
    });
    expect(note?.title).toContain('han bajado');
  });
});
