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

  it('PATCH /units/:id permite corregir el tipo de trastero (equivocación al darlo de alta)', async () => {
    const owner = await registerVerifiedUser(app, 'units-retype');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const otherType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Tipo correcto', defaultPriceMonthly: 40 });
    expect(otherType.status).toBe(201);

    const patch = await request(app.getHttpServer())
      .patch(`/units/${unitIds[0]}`)
      .set(auth)
      .send({ unitTypeId: otherType.body.id });
    expect(patch.status).toBe(200);
    expect(patch.body.unitTypeId).toBe(otherType.body.id);
    expect(patch.body.unitTypeName).toBe('Tipo correcto');

    const detail = await request(app.getHttpServer()).get(`/units/${unitIds[0]}`).set(auth);
    expect(detail.body.unitTypeId).toBe(otherType.body.id);
  });

  it('PATCH /units/:id rechaza cambiar el tipo mientras el trastero está apilado', async () => {
    const owner = await registerVerifiedUser(app, 'units-retype-stacked');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const stackableType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Taquilla', defaultPriceMonthly: 20, stackable: true });
    const otherType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Otro tipo', defaultPriceMonthly: 40 });
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 0,
    });
    async function createUnit(code: string) {
      const res = await request(app.getHttpServer()).post('/units').set(auth).send({
        facilityId,
        unitTypeId: stackableType.body.id,
        code,
        widthM: 1,
        depthM: 1,
        heightM: 2,
      });
      return res.body as { id: string };
    }
    const a = await createUnit('LOCK-A');
    const b = await createUnit('LOCK-B');
    const stack = await request(app.getHttpServer())
      .post(`/units/${a.id}/stack-with`)
      .set(auth)
      .send({ targetUnitId: b.id });
    expect(stack.status).toBe(200);

    const patch = await request(app.getHttpServer())
      .patch(`/units/${a.id}`)
      .set(auth)
      .send({ unitTypeId: otherType.body.id });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('cannot_change_type_while_stacked');
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

  it('PATCH floors/:id/plan rechaza una URL ajena al bucket/local (antes se aceptaba CUALQUIER URL sin validar)', async () => {
    const owner = await registerVerifiedUser(app, 'units-plan-foreign');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { floorId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const foreign = await request(app.getHttpServer())
      .patch(`/floors/${floorId}/plan`)
      .set(auth)
      .send({
        planImageUrl: 'https://evil.example.com/plano-falso.png',
        planWidthPx: 800,
        planHeightPx: 600,
      });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('invalid_plan_url');
  });

  it('PATCH floors/:id/plan rechaza una key propia con bytes reales que no son un tipo permitido', async () => {
    const owner = await registerVerifiedUser(app, 'units-plan-mime');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { floorId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const presign = await request(app.getHttpServer())
      .post(`/floors/${floorId}/plan-upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png', sizeBytes: 1024 });
    expect(presign.status).toBe(200);

    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: '<script>alert(1)</script>',
    }).then((r) => expect(r.status).toBe(200));

    const set = await request(app.getHttpServer())
      .patch(`/floors/${floorId}/plan`)
      .set(auth)
      .send({ planImageUrl: presign.body.publicUrl, planWidthPx: 800, planHeightPx: 600 });
    expect(set.status).toBe(400);
    expect(set.body.code).toBe('invalid_file_content');
  });

  it('PATCH floors/:id/plan acepta una key propia con bytes PNG reales y devuelve una URL firmada GET (bucket `plans` es privado)', async () => {
    const owner = await registerVerifiedUser(app, 'units-plan-real');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, floorId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });

    const presign = await request(app.getHttpServer())
      .post(`/floors/${floorId}/plan-upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png', sizeBytes: 1024 });

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: pngHeader,
    }).then((r) => expect(r.status).toBe(200));

    const set = await request(app.getHttpServer())
      .patch(`/floors/${floorId}/plan`)
      .set(auth)
      .send({ planImageUrl: presign.body.publicUrl, planWidthPx: 800, planHeightPx: 600 });
    expect(set.status).toBe(200);
    // `plans` es un bucket privado: el `planImageUrl` devuelto ya no es la
    // URL "pública" cruda (que daría 403 anónimo) sino una GET firmada sobre
    // la misma key — mismo prefijo + query de firma SigV4.
    expect(set.body.planImageUrl.startsWith(presign.body.publicUrl)).toBe(true);
    expect(set.body.planImageUrl).toContain('X-Amz-Signature');

    // El listado de floors también debe devolver una URL firmada (no la cruda
    // guardada en BD) para que el editor/viewer puedan cargar la imagen.
    const list = await request(app.getHttpServer())
      .get(`/facilities/${facilityId}/floors`)
      .set(auth);
    expect(list.status).toBe(200);
    const floor = list.body.find((f: { id: string }) => f.id === floorId);
    expect(floor.planImageUrl.startsWith(presign.body.publicUrl)).toBe(true);
    expect(floor.planImageUrl).toContain('X-Amz-Signature');
  });

  describe('taquillas apilables (stack-with / unstack)', () => {
    async function setupStackable(suffix: string) {
      const owner = await registerVerifiedUser(app, `units-stack-${suffix}`);
      const auth = { Authorization: `Bearer ${owner.accessToken}` };
      const facility = await request(app.getHttpServer())
        .post('/facilities')
        .set(auth)
        .send({
          name: `Local ${suffix}`,
          city: 'Madrid',
          country: 'ES',
          timezone: 'Europe/Madrid',
        });
      const facilityId = facility.body.id as string;

      const stackableType = await request(app.getHttpServer())
        .post('/unit-types')
        .set(auth)
        .send({ name: 'Taquilla', defaultPriceMonthly: 20, stackable: true });
      const otherType = await request(app.getHttpServer())
        .post('/unit-types')
        .set(auth)
        .send({ name: 'Grande', defaultPriceMonthly: 80, stackable: false });

      async function createUnit(code: string, unitTypeId: string, floorIdOverride?: string) {
        const res = await request(app.getHttpServer())
          .post('/units')
          .set(auth)
          .send({
            facilityId,
            ...(floorIdOverride ? { floorId: floorIdOverride } : {}),
            unitTypeId,
            code,
            widthM: 1,
            depthM: 1,
            heightM: 2,
          });
        return res.body as { id: string; floorId: string };
      }

      const unitA = await createUnit('LOCK-A', stackableType.body.id);
      const unitB = await createUnit('LOCK-B', stackableType.body.id, unitA.floorId);
      const unitC = await createUnit('LOCK-C', stackableType.body.id, unitA.floorId);
      const nonStackable = await createUnit('BIG-1', otherType.body.id, unitA.floorId);

      return { auth, facilityId, floorId: unitA.floorId, unitA, unitB, unitC, nonStackable };
    }

    it('apila dos taquillas del mismo tipo en el mismo hueco (hereda posición del destino)', async () => {
      const { auth, floorId, unitA, unitB } = await setupStackable('ok');

      // Fija una posición conocida en B (el destino) para verificar que A la hereda.
      await request(app.getHttpServer())
        .patch(`/floors/${floorId}/units-layout`)
        .set(auth)
        .send({ units: [{ id: unitB.id, planX: 100, planY: 200, planWidth: 40, planHeight: 40 }] });

      const res = await request(app.getHttpServer())
        .post(`/units/${unitA.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: unitB.id });
      expect(res.status).toBe(200);
      const [joined, target] = res.body as Array<{
        id: string;
        stackGroupId: string | null;
        stackLevel: number | null;
        planX: number | null;
        planY: number | null;
      }>;
      expect(joined.id).toBe(unitA.id);
      expect(target.id).toBe(unitB.id);
      expect(joined.stackGroupId).not.toBeNull();
      expect(joined.stackGroupId).toBe(target.stackGroupId);
      expect(joined.stackLevel).toBe(1);
      expect(target.stackLevel).toBe(0);
      // A hereda la posición de B (comparten el mismo hueco físico).
      expect(joined.planX).toBe(100);
      expect(joined.planY).toBe(200);
    });

    it('rechaza apilar con uno mismo, con un tipo distinto, no apilable, de otra planta, o ya apilado', async () => {
      const { auth, facilityId, unitA, unitB, unitC, nonStackable } =
        await setupStackable('guards');

      const itself = await request(app.getHttpServer())
        .post(`/units/${unitA.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: unitA.id });
      expect(itself.status).toBe(400);
      expect(itself.body.code).toBe('cannot_stack_with_itself');

      const differentType = await request(app.getHttpServer())
        .post(`/units/${unitA.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: nonStackable.id });
      expect(differentType.status).toBe(400);
      expect(differentType.body.code).toBe('stack_type_mismatch');

      const notStackableType = await request(app.getHttpServer())
        .post('/unit-types')
        .set(auth)
        .send({ name: 'No apilable', defaultPriceMonthly: 10, stackable: false });
      const u1 = await request(app.getHttpServer()).post('/units').set(auth).send({
        facilityId,
        unitTypeId: notStackableType.body.id,
        code: 'NS-1',
        widthM: 1,
        depthM: 1,
        heightM: 2,
      });
      const u2 = await request(app.getHttpServer()).post('/units').set(auth).send({
        facilityId,
        unitTypeId: notStackableType.body.id,
        code: 'NS-2',
        widthM: 1,
        depthM: 1,
        heightM: 2,
      });
      const notStackable = await request(app.getHttpServer())
        .post(`/units/${u1.body.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: u2.body.id });
      expect(notStackable.status).toBe(400);
      expect(notStackable.body.code).toBe('unit_type_not_stackable');

      // Ya apilado: apilar A con B, luego intentar apilar C con A -> 400.
      await request(app.getHttpServer())
        .post(`/units/${unitA.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: unitB.id });
      const alreadyStacked = await request(app.getHttpServer())
        .post(`/units/${unitC.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: unitA.id });
      expect(alreadyStacked.status).toBe(400);
      expect(alreadyStacked.body.code).toBe('already_stacked');
    });

    it('desapila: ambas quedan libres, la que se unió se reposiciona desde la posición ACTUAL del ancla', async () => {
      const { auth, floorId, unitA, unitB } = await setupStackable('unstack');

      await request(app.getHttpServer())
        .patch(`/floors/${floorId}/units-layout`)
        .set(auth)
        .send({ units: [{ id: unitB.id, planX: 50, planY: 60, planWidth: 30, planHeight: 30 }] });
      await request(app.getHttpServer())
        .post(`/units/${unitA.id}/stack-with`)
        .set(auth)
        .send({ targetUnitId: unitB.id });

      // Mueve el ancla (B, stackLevel:0) DESPUÉS de apilar, simulando un
      // arrastre en el editor — A (stackLevel:1) no se dibuja/arrastra, así
      // que su planX/Y propio se queda desactualizado.
      await request(app.getHttpServer())
        .patch(`/floors/${floorId}/units-layout`)
        .set(auth)
        .send({ units: [{ id: unitB.id, planX: 500, planY: 600, planWidth: 30, planHeight: 30 }] });

      const unstack = await request(app.getHttpServer())
        .post(`/units/${unitA.id}/unstack`)
        .set(auth);
      expect(unstack.status).toBe(200);
      const byId = Object.fromEntries(
        (unstack.body as Array<{ id: string; stackGroupId: null; planX: number }>).map((u) => [
          u.id,
          u,
        ]),
      );
      expect(byId[unitA.id].stackGroupId).toBeNull();
      expect(byId[unitB.id].stackGroupId).toBeNull();
      // B (ancla) conserva su posición actual (500,600); A se reposiciona
      // relativa a ESA posición actual, no a su propio valor obsoleto.
      expect(byId[unitB.id].planX).toBe(500);
      expect(byId[unitA.id].planX).toBe(520); // 500 + UNSTACK_OFFSET_PX(20)

      const notStacked = await request(app.getHttpServer())
        .post(`/units/${unitA.id}/unstack`)
        .set(auth);
      expect(notStacked.status).toBe(400);
      expect(notStacked.body.code).toBe('not_stacked');
    });
  });
});
