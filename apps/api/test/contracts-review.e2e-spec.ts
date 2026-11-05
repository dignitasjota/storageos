import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ContractsService } from '../src/modules/contracts/contracts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Contratos: prórrogas, trasteros retenidos por otro inquilino,
 * reservas que se convierten, fianza sin cobrar, cierre anticipado y condiciones.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Revisión de Contratos (e2e)', () => {
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

  async function setup(slug: string) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds, facilityId, unitTypeId } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 3 },
    );
    return { owner, auth, unitIds, facilityId, unitTypeId };
  }

  async function draft(
    auth: Record<string, string>,
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; customerId: string }> {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(0), priceMonthly: 50, ...body })
      .expect(201);
    return { id: c.body.id as string, customerId };
  }

  const unitStatus = async (id: string) =>
    (await db.unit.findUniqueOrThrow({ where: { id } })).status;

  it('la prórroga automática repite el plazo original, no lo duplica', async () => {
    const { owner, auth, unitIds } = await setup('ctr-term');
    const c = await draft(auth, owner.accessToken, unitIds[0]!, {
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await http().post(`/contracts/${c.id}/sign`).set(auth).send({}).expect(200);
    const svc = app.get(ContractsService);
    await svc.autoRenewDue();
    const first = await db.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(first.termMonths).toBe(12);
    await db.contract.update({ where: { id: c.id }, data: { endDate: new Date(isoDay(-2)) } });
    await svc.autoRenewDue();
    const second = await db.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(second.termMonths).toBe(12);
    const days = (second.endDate!.getTime() - Date.now()) / DAY;
    expect(days).toBeLessThan(370);
  });

  it('cancelar un borrador no libera un trastero reservado para otro', async () => {
    const { owner, auth, unitIds } = await setup('ctr-cancel');
    const unitId = unitIds[0]!;
    const other = await createCustomer(app, owner.accessToken);
    await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId: other,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    expect(await unitStatus(unitId)).toBe('reserved');
    const c = await draft(auth, owner.accessToken, unitId);
    await http().post(`/contracts/${c.id}/cancel`).set(auth).send({}).expect(200);
    expect(await unitStatus(unitId)).toBe('reserved');
  });

  it('no se firma sobre un trastero retenido por la reserva online de otro', async () => {
    const { owner, auth, unitIds } = await setup('ctr-hold');
    const unitId = unitIds[0]!;
    const online = await draft(auth, owner.accessToken, unitId);
    await db.contract.update({
      where: { id: online.id },
      data: { firstPaymentDeadline: new Date(Date.now() + 2 * DAY) },
    });
    await db.unit.update({ where: { id: unitId }, data: { status: 'reserved' } });
    const panel = await draft(auth, owner.accessToken, unitId);
    const res = await http().post(`/contracts/${panel.id}/sign`).set(auth).send({}).expect(409);
    expect(res.body.code).toBe('unit_reserved_for_other');
    // El dueño de la retención sí firma y, si cancela el otro, sigue retenido.
    await http().post(`/contracts/${online.id}/sign`).set(auth).send({}).expect(200);
    expect(await unitStatus(unitId)).toBe('occupied');
  });

  it('convertir una reserva pasa por el alta normal', async () => {
    const { owner, auth, unitIds } = await setup('ctr-conv');
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);
    await db.customer.update({ where: { id: customerId }, data: { depositExempt: true } });
    const r = await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    const c = await http()
      .post(`/reservations/${r.body.id}/convert-to-contract`)
      .set(auth)
      .send({ startDate: isoDay(0), priceMonthly: 50, depositAmount: 30 })
      .expect(200);
    expect(c.body.depositAmount).toBe(0);
    const row = await db.reservation.findUniqueOrThrow({ where: { id: r.body.id as string } });
    expect(row.status).toBe('converted');
    expect(row.convertedContractId).toBe(c.body.id);
    // Otra vez, ya no se puede.
    const again = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: isoDay(0),
        priceMonthly: 50,
        reservationId: r.body.id,
      })
      .expect(400);
    expect(again.body.code).toBe('reservation_not_convertible');
    // Cancelar el contrato devuelve el trastero: lo retenía esa reserva.
    await http().post(`/contracts/${c.body.id}/cancel`).set(auth).send({}).expect(200);
    expect(await unitStatus(unitId)).toBe('available');
  });

  it('la fianza sin cobrar no se liquida ni consta como recibida', async () => {
    const { owner, auth, unitIds } = await setup('ctr-dep');
    const c = await draft(auth, owner.accessToken, unitIds[0]!, { depositAmount: 80 });
    await http().post(`/contracts/${c.id}/sign`).set(auth).send({}).expect(200);
    const before = await http().get(`/contracts/${c.id}`).set(auth).expect(200);
    expect(before.body.depositCollected).toBe(false);
    const list = await http().get(`/contracts/${c.id}/checklist`).set(auth).expect(200);
    expect(
      (list.body.moveIn as { key: string; done: boolean }[]).find((s) => s.key === 'deposit')?.done,
    ).toBe(false);
    const res = await http()
      .post(`/contracts/${c.id}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 80 })
      .expect(400);
    expect(res.body.code).toBe('deposit_not_collected');
    await http()
      .post(`/contracts/${c.id}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    const after = await http().get(`/contracts/${c.id}`).set(auth).expect(200);
    expect(after.body.depositCollected).toBe(true);
    await http()
      .post(`/contracts/${c.id}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 80 })
      .expect(200);
  });

  it('finalizar antes de tiempo deja la fecha real y las condiciones se editan', async () => {
    const { owner, auth, unitIds } = await setup('ctr-end');
    const c = await draft(auth, owner.accessToken, unitIds[0]!, { endDate: isoDay(200) });
    await http().post(`/contracts/${c.id}/sign`).set(auth).send({}).expect(200);
    await http()
      .patch(`/contracts/${c.id}`)
      .set(auth)
      .send({ autoRenew: false, cancellationNoticeDays: 30 })
      .expect(200);
    const events = await http().get(`/contracts/${c.id}/events`).set(auth).expect(200);
    expect(
      (events.body as { payload: { event?: string } }[]).some(
        (e) => e.payload.event === 'conditions_updated',
      ),
    ).toBe(true);
    await http().post(`/contracts/${c.id}/request-end`).set(auth).send({}).expect(200);
    const noDate = await http()
      .patch(`/contracts/${c.id}`)
      .set(auth)
      .send({ endDate: '' })
      .expect(400);
    expect(noDate.body.code).toBe('ending_requires_date');
    const ended = await http().post(`/contracts/${c.id}/end`).set(auth).send({}).expect(200);
    expect((ended.body.endDate as string) <= isoDay(1)).toBe(true);
    const closed = await http().patch(`/contracts/${c.id}`).set(auth).send({ notes: 'x' });
    expect(closed.status).toBe(400);
    expect(closed.body.code).toBe('contract_closed');
  });

  it('valida fechas y descuento, y busca por varias palabras', async () => {
    const { owner, auth, unitIds } = await setup('ctr-val');
    const customerId = await createCustomer(app, owner.accessToken);
    const bad = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: isoDay(0),
        endDate: isoDay(-5),
        priceMonthly: 50,
      })
      .expect(400);
    expect(bad.body.code).toBe('invalid_end_date');
    const high = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: isoDay(0),
        priceMonthly: 50,
        discountAmount: 60,
      })
      .expect(400);
    expect(high.body.code).toBe('discount_too_high');
    await db.customer.update({
      where: { id: customerId },
      data: { firstName: 'Lucía', lastName: 'Fernández' },
    });
    await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(0), priceMonthly: 50 })
      .expect(201);
    const found = await http()
      .get('/contracts/page')
      .set(auth)
      .query({ search: 'Lucía Fernández' })
      .expect(200);
    expect(found.body.items).toHaveLength(1);
  });

  it('cancelar una reserva con trastero retenido avisa a la lista de espera', async () => {
    const { owner, auth, unitIds, facilityId, unitTypeId } = await setup('ctr-wait');
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);
    const r = await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    const w = await http()
      .post('/waitlist')
      .set(auth)
      .send({ facilityId, unitTypeId, contactName: 'Ana', contactEmail: 'ana@example.com' })
      .expect(201);
    await http().post(`/reservations/${r.body.id}/cancel`).set(auth).send({}).expect(200);
    await new Promise((ok) => setTimeout(ok, 300));
    const entry = await db.waitlistEntry.findUniqueOrThrow({ where: { id: w.body.id as string } });
    expect(entry.status).toBe('notified');
  });
});
