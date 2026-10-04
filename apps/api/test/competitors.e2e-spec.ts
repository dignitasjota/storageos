import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Competencia + precio por competencia (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('ficha competencia y ancla la sugerencia de precio', async () => {
    const owner = await registerVerifiedUser(app, 'competitor');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Mi local + tipo + trastero disponible caro (200€, 5 m²).
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Mi Local', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 200 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'C-001',
      widthM: 2,
      depthM: 2.5,
      heightM: 2.5,
      basePriceMonthly: 200,
    });
    const unitId = unit.body.id as string;

    // Competidor con dos trasteros de 5 m² a 100 € con IVA (82,64 € sin IVA).
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival Storage', zone: 'Centro' });
    expect(comp.status).toBe(201);
    const compUnit = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ areaM2: 5, priceMonthly: 100, status: 'available' });
    expect(compUnit.status).toBe(201);
    expect(compUnit.body.lastCheckedAt).toBeTruthy();
    await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ areaM2: 5, priceMonthly: 100, status: 'available' })
      .expect(201);

    // Sin competencia: solo demanda (−10 %), confianza baja → paso del 4 %.
    const noComp = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions?includeCompetition=false')
      .set(auth);
    const base = noComp.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(base.marketPrice).toBeNull();
    expect(base.suggestedPrice).toBe(192);

    // Con competencia: mercado ~83 € y confianza media → baja el máximo (8 %).
    const withComp = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item = withComp.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item.marketPrice).toBeCloseTo(82.64, 1);
    expect(item.confidence).toBe('medium');
    expect(item.suggestedPrice).toBe(184);
    expect(item.factors.some((f: { label: string }) => f.label === 'Mercado')).toBe(true);

    // Un trastero ocupado de la competencia sigue siendo precio de mercado.
    await request(app.getHttpServer())
      .patch(`/competitors/units/${compUnit.body.id}`)
      .set(auth)
      .send({ status: 'occupied' })
      .expect(200);
    const afterOccupied = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item2 = afterOccupied.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item2.marketPrice).toBeCloseTo(82.64, 1);
  });

  it('editar un competidor existente (nombre, zona, flag de IVA)', async () => {
    const owner = await registerVerifiedUser(app, 'comp-edit');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Antiguo', zone: 'Norte', priceIncludesVat: true });
    expect(comp.status).toBe(201);

    const upd = await request(app.getHttpServer())
      .patch(`/competitors/${comp.body.id}`)
      .set(auth)
      .send({ name: 'Nuevo Nombre', zone: 'Sur', priceIncludesVat: false });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Nuevo Nombre');
    expect(upd.body.zone).toBe('Sur');
    expect(upd.body.priceIncludesVat).toBe(false);

    // Persiste en el listado.
    const list = await request(app.getHttpServer()).get('/competitors').set(auth);
    const found = list.body.find((f: { id: string }) => f.id === comp.body.id);
    expect(found.name).toBe('Nuevo Nombre');
    expect(found.priceIncludesVat).toBe(false);
  });

  it('medidas → área calculada + flag de IVA por competidor', async () => {
    const owner = await registerVerifiedUser(app, 'comp-dims');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Competidor con precios SIN IVA.
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival Medidas', priceIncludesVat: false });
    expect(comp.status).toBe(201);
    expect(comp.body.priceIncludesVat).toBe(false);

    // Trastero por MEDIDAS (sin área): 2 × 3 → área calculada = 6.
    const u = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ widthM: 2, depthM: 3, heightM: 2.5, priceMonthly: 80, status: 'available' });
    expect(u.status).toBe(201);
    expect(u.body.areaM2).toBe(6);
    expect(u.body.widthM).toBe(2);
    expect(u.body.depthM).toBe(3);
    expect(u.body.heightM).toBe(2.5);

    // Cambiar el fondo a 4 → área recalculada = 8.
    const upd = await request(app.getHttpServer())
      .patch(`/competitors/units/${u.body.id}`)
      .set(auth)
      .send({ depthM: 4 });
    expect(upd.status).toBe(200);
    expect(upd.body.areaM2).toBe(8);
    expect(upd.body.depthM).toBe(4);

    // Trastero sin medidas: se acepta el área directa (retrocompatible).
    const u2 = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ areaM2: 10, priceMonthly: 120, status: 'available' });
    expect(u2.status).toBe(201);
    expect(u2.body.areaM2).toBe(10);
    expect(u2.body.widthM).toBeNull();

    // Ni área ni medidas → 400.
    await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ priceMonthly: 50, status: 'available' })
      .expect(400);
  });

  it('ocupación de mercado: la mía (0%) vs la de la competencia (inferida)', async () => {
    const owner = await registerVerifiedUser(app, 'market-occ');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Mi local con 1 trastero disponible → mi ocupación 0%.
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local', addressLine1: 'C/ X', city: 'Madrid', postalCode: '28001' });
    const ut = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Std', defaultPriceMonthly: 100 });
    await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: ut.body.id,
      code: 'A-1',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });

    // Sin competencia fichada → competitionOccupancyPct null, totales 0.
    const empty = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.myTotalUnits).toBe(1);
    expect(empty.body.myOccupancyPct).toBe(0);
    expect(empty.body.competitionOccupancyPct).toBeNull();
    expect(empty.body.competitionTotalUnits).toBe(0);

    // Competidor con 4 trasteros: 3 ocupados, 1 disponible → 75%.
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival', zone: 'Z' });
    for (const st of ['occupied', 'occupied', 'occupied', 'available']) {
      await request(app.getHttpServer())
        .post(`/competitors/${comp.body.id}/units`)
        .set(auth)
        .send({ areaM2: 5, priceMonthly: 90, status: st })
        .expect(201);
    }

    // Sin inventario completo no se sabe su total → su ocupación no cuenta.
    const unknown = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(unknown.body.competitionOccupancyPct).toBeNull();
    expect(unknown.body.competitors[0].occupancyPct).toBeNull();

    // Con un total conocido (10, 1 libre) → 90%.
    await request(app.getHttpServer())
      .patch(`/competitors/${comp.body.id}`)
      .set(auth)
      .send({ knownTotalUnits: 10 })
      .expect(200);
    const known = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(known.body.competitors[0]).toMatchObject({ unitCount: 10, occupancyPct: 0.9 });

    // Inventario completo → se usan los 4 fichados.
    const done = await request(app.getHttpServer())
      .patch(`/competitors/${comp.body.id}`)
      .set(auth)
      .send({ inventoryComplete: true });
    expect(done.body.inventoryComplete).toBe(true);
    expect(done.body.inventoryCompletedAt).toBeTruthy();

    const occ = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(occ.body.competitionTotalUnits).toBe(4);
    expect(occ.body.competitionOccupiedUnits).toBe(3);
    expect(occ.body.competitionOccupancyPct).toBe(0.75);
    expect(occ.body.competitors).toHaveLength(1);
    expect(occ.body.competitors[0]).toMatchObject({
      name: 'Rival',
      unitCount: 4,
      occupiedCount: 3,
      occupancyPct: 0.75,
    });
  });

  it('contacto, histórico de cada trastero y revisión', async () => {
    const owner = await registerVerifiedUser(app, 'comp-history');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({
        name: 'Rival Contacto',
        phone: '600 111 222',
        website: 'rival.es',
        contactMethod: 'web',
        contactNotes: 'Página «Disponibilidad»',
        distanceKm: 1.5,
        currentPromotion: 'Primer mes gratis',
        depositAmount: 50,
        features: ['24h', 'climate', '24h'],
      });
    expect(comp.status).toBe(201);
    expect(comp.body).toMatchObject({
      phone: '600 111 222',
      contactMethod: 'web',
      contactNotes: 'Página «Disponibilidad»',
      distanceKm: 1.5,
      depositAmount: 50,
      inventoryComplete: false,
      lastReviewedAt: null,
    });
    expect(comp.body.features).toEqual(['24h', 'climate']);

    // Forma de contacto inválida → 400.
    await request(app.getHttpServer())
      .patch(`/competitors/${comp.body.id}`)
      .set(auth)
      .send({ contactMethod: 'paloma' })
      .expect(400);

    const u = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ areaM2: 5, priceMonthly: 100, status: 'available', externalRef: 'A-12' });
    expect(u.body.externalRef).toBe('A-12');
    expect(u.body.history.observations).toBe(1);

    // Editar solo las notas no es una comprobación nueva.
    await request(app.getHttpServer())
      .patch(`/competitors/units/${u.body.id}`)
      .set(auth)
      .send({ notes: 'junto al ascensor' })
      .expect(200);

    // Sube de precio y se alquila → nueva comprobación.
    const upd = await request(app.getHttpServer())
      .patch(`/competitors/units/${u.body.id}`)
      .set(auth)
      .send({ priceMonthly: 110, status: 'occupied' });
    expect(upd.body.history).toMatchObject({
      observations: 2,
      firstPrice: 100,
      priceChangePct: 10,
      timesRented: 1,
    });

    // Revisión: vuelve a estar libre al mismo precio.
    const rev = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/review`)
      .set(auth)
      .send({ units: [{ id: u.body.id, priceMonthly: 110, status: 'available' }] });
    expect(rev.status).toBe(200);
    expect(rev.body[0].history.observations).toBe(3);
    expect(rev.body[0].status).toBe('available');

    const list = await request(app.getHttpServer()).get('/competitors').set(auth);
    expect(list.body[0].lastReviewedAt).toBeTruthy();

    const hist = await request(app.getHttpServer())
      .get(`/competitors/units/${u.body.id}/history`)
      .set(auth);
    expect(hist.status).toBe(200);
    expect(hist.body.map((o: { priceMonthly: number }) => o.priceMonthly)).toEqual([110, 110, 100]);

    // Un trastero de otro competidor no se puede revisar desde este.
    const other = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Otro' });
    await request(app.getHttpServer())
      .post(`/competitors/${other.body.id}/review`)
      .set(auth)
      .send({ units: [{ id: u.body.id, priceMonthly: 1, status: 'available' }] })
      .expect(404);
  });

  it('el historial de precios de mis trasteros guarda los cambios manuales', async () => {
    const owner = await registerVerifiedUser(app, 'unit-price-hist');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Historial', addressLine1: 'C/ X', city: 'Madrid', postalCode: '28001' });
    const ut = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Std', defaultPriceMonthly: 100 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: ut.body.id,
      code: 'H-1',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });
    await request(app.getHttpServer())
      .patch(`/units/${unit.body.id}`)
      .set(auth)
      .send({ basePriceMonthly: 120 })
      .expect(200);
    // Mismo precio → no se registra.
    await request(app.getHttpServer())
      .patch(`/units/${unit.body.id}`)
      .set(auth)
      .send({ basePriceMonthly: 120 })
      .expect(200);

    const rows = await app
      .get(PrismaAdminService)
      .unitPriceHistory.findMany({ where: { unitId: unit.body.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.previousPrice)).toBe(100);
    expect(Number(rows[0]!.newPrice)).toBe(120);
    expect(rows[0]!.source).toBe('manual');
  });
});
