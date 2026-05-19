import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Units + dashboard (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('crea unit con default floor automatica + columnas generadas correctas', async () => {
    const owner = await registerVerifiedUser(app, 'units-create');
    const { unitIds, floorId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    expect(unitIds).toHaveLength(1);
    expect(floorId).toBeTruthy();

    const detail = await request(app.getHttpServer())
      .get(`/units/${unitIds[0]}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.status).toBe(200);
    // 2 m * 3 m = 6 m2, 6 * 2.5 = 15 m3
    expect(Number(detail.body.areaM2)).toBeCloseTo(6, 3);
    expect(Number(detail.body.volumeM3)).toBeCloseTo(15, 3);
    expect(detail.body.status).toBe('available');
    expect(detail.body.floorName).toBe('Planta principal');
  });

  it('codigo duplicado en mismo facility -> 409', async () => {
    const owner = await registerVerifiedUser(app, 'units-dup');
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 0,
    });
    const first = await request(app.getHttpServer())
      .post('/units')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId,
        unitTypeId,
        code: 'A-1',
        widthM: 1,
        depthM: 1,
        heightM: 2,
      });
    expect(first.status).toBe(201);
    const dup = await request(app.getHttpServer())
      .post('/units')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId,
        unitTypeId,
        code: 'A-1',
        widthM: 2,
        depthM: 2,
        heightM: 2,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('unit_code_taken');
  });

  it('change-status escribe en history y respeta transiciones', async () => {
    const owner = await registerVerifiedUser(app, 'units-status');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const id = unitIds[0]!;

    // available -> maintenance OK
    const r1 = await request(app.getHttpServer())
      .post(`/units/${id}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'maintenance', reason: 'limpieza' });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('maintenance');

    // maintenance -> occupied PROHIBIDO (solo via contrato)
    const r2 = await request(app.getHttpServer())
      .post(`/units/${id}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'occupied' });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('occupied_via_contract_only');

    // maintenance -> reserved INVALIDO segun ALLOWED_TRANSITIONS
    const r3 = await request(app.getHttpServer())
      .post(`/units/${id}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'reserved' });
    expect(r3.status).toBe(400);
    expect(r3.body.code).toBe('invalid_status_transition');

    // maintenance -> available OK
    const r4 = await request(app.getHttpServer())
      .post(`/units/${id}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'available' });
    expect(r4.status).toBe(200);

    const hist = await request(app.getHttpServer())
      .get(`/units/${id}/history`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(hist.status).toBe(200);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].newStatus).toBe('available');
    expect(hist.body[1].newStatus).toBe('maintenance');
    expect(hist.body[1].reason).toBe('limpieza');
  });

  it('listado con filtros funciona', async () => {
    const owner = await registerVerifiedUser(app, 'units-filter');
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
    });
    // Cambiar uno a maintenance
    await request(app.getHttpServer())
      .post(`/units/${unitIds[0]}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'maintenance' });

    const all = await request(app.getHttpServer())
      .get(`/units?facilityId=${facilityId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);

    const onlyMaint = await request(app.getHttpServer())
      .get(`/units?facilityId=${facilityId}&status=maintenance`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(onlyMaint.body.items).toHaveLength(1);
  });

  it('/dashboard/occupancy agrega correctamente', async () => {
    const owner = await registerVerifiedUser(app, 'units-dash');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 4,
    });
    // 1 -> maintenance, otros 3 quedan available
    await request(app.getHttpServer())
      .post(`/units/${unitIds[0]}/change-status`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'maintenance' });

    const dash = await request(app.getHttpServer())
      .get('/dashboard/occupancy')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(dash.status).toBe(200);
    expect(dash.body.totalUnits).toBe(4);
    expect(dash.body.byStatus.available).toBe(3);
    expect(dash.body.byStatus.maintenance).toBe(1);
    expect(dash.body.byFacility).toHaveLength(1);
    expect(dash.body.byUnitType).toHaveLength(1);
  });

  it('plan-upload-url devuelve URL firmada PUT y publicUrl', async () => {
    const owner = await registerVerifiedUser(app, 'units-plan');
    const { floorId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const res = await request(app.getHttpServer())
      .post(`/floors/${floorId}/plan-upload-url`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mimeType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(res.body.publicUrl).toMatch(/^https?:\/\//);
    expect(res.body.requiredHeaders['Content-Type']).toBe('image/png');
  });
});
