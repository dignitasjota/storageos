import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { WaitlistService } from '../src/modules/waitlist/waitlist.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Trasteros: un trastero con contrato o guardado para alguien no
 * cambia de estado a mano, lo apilado se edita sin romper la pareja, borrar
 * avisa de lo pendiente y el historial sigue al trastero tras un traslado.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('Revisión de Trasteros (e2e)', () => {
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

  async function setup(slug: string, unitsCount = 2) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, { unitsCount });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, tenantId: tenant.id, ...f };
  }

  const signed = async (auth: Record<string, string>, token: string, unitId: string) => {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(-30), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { id: c.body.id as string, customerId };
  };

  const status = async (id: string) => (await db.unit.findUniqueOrThrow({ where: { id } })).status;

  const changeStatus = (auth: Record<string, string>, id: string, body: object) =>
    http().post(`/units/${id}/change-status`).set(auth).send(body);

  const reserve = async (s: Awaited<ReturnType<typeof setup>>, unitId: string) => {
    const customerId = await createCustomer(app, s.owner.accessToken);
    await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
  };

  const joinWaitlist = (s: Awaited<ReturnType<typeof setup>>, name: string) =>
    http()
      .post('/waitlist')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        contactName: name,
        contactEmail: `${name.toLowerCase()}@example.com`,
      })
      .expect(201);

  async function stackedPair(s: Awaited<ReturnType<typeof setup>>) {
    const type = await http()
      .post('/unit-types')
      .set(s.auth)
      .send({ name: 'Taquilla', defaultPriceMonthly: 20, stackable: true })
      .expect(201);
    const make = async (code: string) =>
      (
        await http()
          .post('/units')
          .set(s.auth)
          .send({
            facilityId: s.facilityId,
            unitTypeId: type.body.id,
            code,
            widthM: 1,
            depthM: 1,
            heightM: 1,
          })
          .expect(201)
      ).body as { id: string; floorId: string; unitTypeId: string };
    const upper = await make('T1');
    const lower = await make('T2');
    await http()
      .post(`/units/${upper.id}/stack-with`)
      .set(s.auth)
      .send({ targetUnitId: lower.id })
      .expect(200);
    return { upper, lower };
  }

  it('un trastero con contrato en vigor no cambia de estado a mano', async () => {
    const s = await setup('urv-live', 1);
    const unitId = s.unitIds[0]!;
    await signed(s.auth, s.owner.accessToken, unitId);

    for (const target of ['available', 'maintenance', 'blocked']) {
      const res = await changeStatus(s.auth, unitId, { status: target });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('unit_has_live_contract');
    }
    const bulk = await http()
      .post('/units/bulk')
      .set(s.auth)
      .send({ action: 'status', unitIds: [unitId], status: 'available' })
      .expect(200);
    expect(bulk.body.updated).toBe(0);
    expect(bulk.body.failed[0]).toMatchObject({ code: 'unit_has_live_contract' });
    expect(bulk.body.failed[0].unitCode).toBeTruthy();
    expect(await status(unitId)).toBe('occupied');

    // Lo que ya estuviera mal se ve en descuadres y se corrige desde ahí.
    await db.unit.update({ where: { id: unitId }, data: { status: 'maintenance' } });
    const issues = await http().get('/inventory/issues').set(s.auth).expect(200);
    expect(issues.body[0]).toMatchObject({ unitId, expectedStatus: 'occupied' });
    await http().post(`/inventory/issues/${unitId}/fix`).set(s.auth).expect(200);
    expect(await status(unitId)).toBe('occupied');
  });

  it('lo guardado para alguien no vuelve a la venta y «Reservado» no se pone a mano', async () => {
    const s = await setup('urv-held', 2);
    const unitId = s.unitIds[0]!;

    const manual = await changeStatus(s.auth, s.unitIds[1]!, { status: 'reserved' });
    expect(manual.status).toBe(400);
    expect(manual.body.code).toBe('invalid_status_transition');

    await reserve(s, unitId);
    expect((await changeStatus(s.auth, unitId, { status: 'available' })).status).toBe(409);

    // Se bloquea un rato por una avería: al volver sigue siendo de esa persona.
    await changeStatus(s.auth, unitId, { status: 'blocked' }).expect(200);
    const back = await changeStatus(s.auth, unitId, { status: 'available' });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('reserved');
    expect(await status(unitId)).toBe('reserved');
    const list = await http().get('/units?status=available').set(s.auth).expect(200);
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual([s.unitIds[1]]);
  });

  it('descuadres no toma por huérfano lo guardado para la cola o un traslado', async () => {
    const s = await setup('urv-issues', 3);
    await joinWaitlist(s, 'Ana');
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: s.unitIds[0]! });
    expect(await status(s.unitIds[0]!)).toBe('reserved');
    const c = await signed(s.auth, s.owner.accessToken, s.unitIds[1]!);
    await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: s.unitIds[2], effectiveDate: isoDay(7) })
      .expect(200);
    expect(await status(s.unitIds[2]!)).toBe('reserved');

    const issues = await http().get('/inventory/issues').set(s.auth).expect(200);
    expect(issues.body).toEqual([]);
    await http().post(`/inventory/issues/${s.unitIds[0]}/fix`).set(s.auth).expect(409);
  });

  it('un trastero apilado se edita, pero no se separa ni se borra sin desapilar', async () => {
    const s = await setup('urv-stack', 0);
    const { upper, lower } = await stackedPair(s);

    // Lo que manda el formulario de la ficha: todos los campos.
    const edit = await http().patch(`/units/${upper.id}`).set(s.auth).send({
      floorId: upper.floorId,
      unitTypeId: upper.unitTypeId,
      widthM: 1,
      depthM: 1,
      heightM: 1,
      basePriceMonthly: 25,
      notes: 'Candado nuevo',
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ basePriceMonthly: 25, notes: 'Candado nuevo' });

    const otherType = await http()
      .post('/unit-types')
      .set(s.auth)
      .send({ name: 'Otro', defaultPriceMonthly: 30 })
      .expect(201);
    const type = await http()
      .patch(`/units/${upper.id}`)
      .set(s.auth)
      .send({ unitTypeId: otherType.body.id });
    expect(type.status).toBe(400);
    expect(type.body.code).toBe('cannot_change_type_while_stacked');

    const floor = await http()
      .post(`/facilities/${s.facilityId}/floors`)
      .set(s.auth)
      .send({ name: 'Altillo', floorNumber: 1 })
      .expect(201);
    const move = await http()
      .patch(`/units/${upper.id}`)
      .set(s.auth)
      .send({ floorId: floor.body.id });
    expect(move.status).toBe(400);
    expect(move.body.code).toBe('cannot_change_floor_while_stacked');

    const del = await http().delete(`/units/${lower.id}`).set(s.auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('unit_stacked');

    await http().post(`/units/${upper.id}/unstack`).set(s.auth).expect(200);
    await http().delete(`/units/${lower.id}`).set(s.auth).expect(204);

    // Fuera de la pareja, mover de planta borra la posición del otro plano.
    await db.unit.update({ where: { id: upper.id }, data: { planX: 10, planY: 10 } });
    const moved = await http()
      .patch(`/units/${upper.id}`)
      .set(s.auth)
      .send({ floorId: floor.body.id })
      .expect(200);
    expect(moved.body).toMatchObject({ floorId: floor.body.id, planX: null, planY: null });
  });

  it('borrar dice qué queda pendiente y no se pierde quien lo tuvo', async () => {
    const s = await setup('urv-del', 5);
    const [origin, moveTarget, held, offered, moved] = s.unitIds as [
      string,
      string,
      string,
      string,
      string,
    ];
    const c = await signed(s.auth, s.owner.accessToken, origin);
    await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: moveTarget, effectiveDate: isoDay(7) })
      .expect(200);
    const delMove = await http().delete(`/units/${moveTarget}`).set(s.auth);
    expect(delMove.status).toBe(409);
    expect(delMove.body.code).toBe('unit_has_pending');
    expect(delMove.body.message).toContain('traslado');

    await joinWaitlist(s, 'Luis');
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: held });
    const delHeld = await http().delete(`/units/${held}`).set(s.auth);
    expect(delHeld.status).toBe(409);
    expect(delHeld.body.message).toContain('lista de espera');

    await http()
      .post('/promotions/unit-offers')
      .set(s.auth)
      .send({ unitId: offered, freeMonths: 1, validDays: 30 })
      .expect(201);
    const delOffer = await http().delete(`/units/${offered}`).set(s.auth);
    expect(delOffer.status).toBe(409);
    expect(delOffer.body.message).toContain('oferta');

    // El trastero del que se fue un contrato sigue siendo historia.
    await http().delete(`/contracts/${c.id}/scheduled-move`).set(s.auth).expect(200);
    await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: moved })
      .expect(200);
    const delOrigin = await http().delete(`/units/${origin}`).set(s.auth);
    expect(delOrigin.status).toBe(409);
    expect(delOrigin.body.code).toBe('unit_has_history');
  });

  it('el historial sigue al trastero tras un traslado', async () => {
    const s = await setup('urv-tenancy', 2);
    await ensureDefaultSeries(app, s.owner.accessToken);
    const [origin, target] = s.unitIds as [string, string];
    const c = await signed(s.auth, s.owner.accessToken, origin);
    await db.unitTenancy.updateMany({
      where: { contractId: c.id },
      data: { startedOn: new Date(isoDay(-30)) },
    });
    const invoice = await http()
      .post('/invoices')
      .set(s.auth)
      .send({
        customerId: c.customerId,
        contractId: c.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${invoice.body.id}/issue`).set(s.auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: invoice.body.id },
      data: { issueDate: new Date(isoDay(-10)) },
    });

    await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: target, newPrice: 70 })
      .expect(200);

    const from = await http().get(`/units/${origin}/insights`).set(s.auth).expect(200);
    expect(from.body.tenancies).toHaveLength(1);
    expect(from.body.tenancies[0]).toMatchObject({
      contractId: c.id,
      movedAway: true,
      priceMonthly: 50,
      invoiced: 100,
    });
    expect(from.body.tenancies[0].endDate).not.toBeNull();
    expect(from.body.daysRentedLastYear).toBeGreaterThanOrEqual(29);
    // Sin IVA, y solo una vez.
    expect(from.body.revenue12m).toBe(100);
    expect(from.body.daysTrackedLastYear).toBeLessThan(365);

    const to = await http().get(`/units/${target}/insights`).set(s.auth).expect(200);
    expect(to.body.tenancies).toHaveLength(1);
    expect(to.body.tenancies[0]).toMatchObject({
      movedAway: false,
      priceMonthly: 70,
      endDate: null,
      invoiced: 0,
    });

    await http().post(`/contracts/${c.id}/end`).set(s.auth).send({}).expect(200);
    const ended = await db.unitTenancy.findFirstOrThrow({ where: { unitId: target } });
    expect(ended.endedOn).not.toBeNull();
    const after = await http().get(`/units/${target}/insights`).set(s.auth).expect(200);
    expect(after.body.tenancies[0].status).toBe('ended');
    expect(after.body.tenancies[0].movedAway).toBe(false);
  });

  it('ni un borrador ni una reserva anticipada cuentan hasta que empiezan', async () => {
    const s = await setup('urv-draft', 1);
    const customerId = await createCustomer(app, s.owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: s.unitIds[0], startDate: isoDay(1), priceMonthly: 50 })
      .expect(201);
    const tenancies = () => db.unitTenancy.count({ where: { contractId: c.body.id } });
    expect(await tenancies()).toBe(0);

    await db.contract.update({
      where: { id: c.body.id },
      data: { preOpening: true, status: 'active', signedAt: new Date() },
    });
    expect(await tenancies()).toBe(0);

    await db.contract.update({
      where: { id: c.body.id },
      data: { preOpeningStartedAt: new Date() },
    });
    expect(await tenancies()).toBe(1);
  });

  it('lote y alta masiva avisan bien', async () => {
    const s = await setup('urv-bulk', 2);
    const unitIds = s.unitIds;
    const zero = await http()
      .post('/units/bulk')
      .set(s.auth)
      .send({ action: 'price', unitIds, mode: 'set', value: 0 });
    expect(zero.status).toBe(400);

    await http()
      .patch(`/units/${unitIds[0]}`)
      .set(s.auth)
      .send({ basePriceMonthly: 900_000 })
      .expect(200);
    const over = await http()
      .post('/units/bulk')
      .set(s.auth)
      .send({ action: 'price', unitIds, mode: 'percent', value: 100 })
      .expect(200);
    expect(over.body.updated).toBe(1);
    expect(over.body.failed[0]).toMatchObject({ code: 'invalid_price' });
    expect(over.body.failed[0].error).not.toContain('.ts');

    await setTenantPlan(s.owner.slug, 'free');
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'free' } });
    const res = await http()
      .post('/units/bulk-create')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        prefix: 'L-',
        start: 1,
        count: plan.maxUnits! - unitIds.length + 3,
        widthM: 1,
        depthM: 1,
        heightM: 1,
      })
      .expect(201);
    expect(res.body.created).toBe(plan.maxUnits! - unitIds.length);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.overLimit).toHaveLength(3);
  });

  it('valores fuera de rango dan 400, no un error interno', async () => {
    const s = await setup('urv-range', 1);
    for (const query of [
      'limit=abc',
      'cursor=x',
      'facilityId=x',
      'floorId=x',
      'unitTypeId=x',
      'status=x',
    ]) {
      const res = await http().get(`/units?${query}`).set(s.auth);
      expect([query, res.status === 400 || res.status === 200]).toEqual([query, true]);
    }
    expect((await http().get('/units?facilityId=x').set(s.auth)).body.code).toBe('invalid_id');
    await http().get('/units?limit=abc').set(s.auth).expect(200);

    await http()
      .post('/units')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        code: 'BIG',
        widthM: 100_000,
        depthM: 2,
        heightM: 2,
      })
      .expect(400);
    await http()
      .patch(`/units/${s.unitIds[0]}`)
      .set(s.auth)
      .send({ basePriceMonthly: 1e9 })
      .expect(400);
  });

  it('mantenimiento: fecha válida, rastro del cambio y la tarea se cierra al volver', async () => {
    const s = await setup('urv-maint', 1);
    const unitId = s.unitIds[0]!;
    const past = await changeStatus(s.auth, unitId, { status: 'maintenance', until: '2020-01-01' });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('invalid_until');

    await changeStatus(s.auth, unitId, {
      status: 'maintenance',
      until: isoDay(5),
      createTask: true,
    }).expect(200);
    await changeStatus(s.auth, unitId, { status: 'maintenance', until: isoDay(20) }).expect(200);
    const history = await http().get(`/units/${unitId}/history`).set(s.auth).expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[0].reason).toContain('Nueva fecha prevista');

    await changeStatus(s.auth, unitId, { status: 'available' }).expect(200);
    const task = await db.task.findFirstOrThrow({ where: { unitId } });
    expect(task.status).toBe('done');
    expect(task.completedAt).not.toBeNull();
  });

  it('se busca por inquilino y contrato', async () => {
    const s = await setup('urv-search', 2);
    const customerId = await createCustomer(app, s.owner.accessToken, {
      firstName: 'Remedios',
      lastName: 'Amaya Vega',
    });
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: s.unitIds[0], startDate: isoDay(-1), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({}).expect(200);

    const byName = await http().get('/units?search=remedios%20vega').set(s.auth).expect(200);
    expect(byName.body.items.map((u: { id: string }) => u.id)).toEqual([s.unitIds[0]]);
    const byContract = await http()
      .get(`/units?search=${encodeURIComponent(c.body.contractNumber as string)}`)
      .set(s.auth)
      .expect(200);
    expect(byContract.body.items).toHaveLength(1);
  });
});
