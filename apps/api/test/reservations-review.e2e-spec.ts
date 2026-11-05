import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { WaitlistService } from '../src/modules/waitlist/waitlist.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de reservas, lista de espera, cambios y solicitudes de trastero. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Revisión de reservas y lista de espera (e2e)', () => {
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

  async function setup(slug: string, unitsCount = 1) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, { unitsCount });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, tenantId: tenant.id, ...f };
  }

  const unitStatus = async (id: string) =>
    (await db.unit.findUniqueOrThrow({ where: { id } })).status;

  const join = (
    auth: Record<string, string>,
    f: { facilityId: string; unitTypeId: string },
    name: string,
  ) =>
    http()
      .post('/waitlist')
      .set(auth)
      .send({
        facilityId: f.facilityId,
        unitTypeId: f.unitTypeId,
        contactName: name,
        contactEmail: `${name.toLowerCase()}@example.com`,
      });

  const reserve = (
    auth: Record<string, string>,
    unitId: string,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7 * DAY).toISOString(),
        confirmImmediately: true,
        ...extra,
      });

  async function portalAuth(slug: string, email: string) {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const res = await http().post('/portal/login/consume').send({ token });
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  it('un trastero guardado para otro no se reserva ni se pone a la venta', async () => {
    const s = await setup('rrv-held');
    const unitId = s.unitIds[0]!;
    await join(s.auth, s, 'Ana').expect(201);
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId });
    expect(await unitStatus(unitId)).toBe('reserved');

    const customerId = await createCustomer(app, s.owner.accessToken);
    const res = await reserve(s.auth, unitId, { customerId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('unit_held_by_other');

    const manual = await http()
      .post(`/units/${unitId}/change-status`)
      .set(s.auth)
      .send({ status: 'available' });
    expect(manual.status).toBe(409);
    expect(await unitStatus(unitId)).toBe('reserved');
  });

  it('cancelar una reserva no suelta lo que otro retiene', async () => {
    const s = await setup('rrv-cancel');
    const unitId = s.unitIds[0]!;
    const customerId = await createCustomer(app, s.owner.accessToken);
    const r = await reserve(s.auth, unitId, { customerId }).expect(201);
    // El aviso de la cola llega con la reserva ya puesta (datos anteriores a este arreglo).
    const entry = await join(s.auth, s, 'Luis').expect(201);
    await db.waitlistEntry.update({
      where: { id: entry.body.id as string },
      data: { status: 'notified', notifiedAt: new Date(), heldUnitId: unitId },
    });
    await http().post(`/reservations/${r.body.id}/cancel`).set(s.auth).send({}).expect(200);
    expect(await unitStatus(unitId)).toBe('reserved');
    // Cancelar dos veces no hace nada dos veces.
    const again = await http().post(`/reservations/${r.body.id}/cancel`).set(s.auth).send({});
    expect(again.status).toBe(400);
  });

  it('dos trasteros liberados a la vez: una persona, un trastero', async () => {
    const s = await setup('rrv-race', 2);
    await join(s.auth, s, 'Eva').expect(201);
    const svc = app.get(WaitlistService);
    await Promise.all(
      s.unitIds.map((unitId) => svc.onUnitAvailable({ tenantId: s.tenantId, unitId })),
    );
    const statuses = await Promise.all(s.unitIds.map(unitStatus));
    expect(statuses.sort()).toEqual(['available', 'reserved']);
    const mails = await db.communication.count({
      where: { tenantId: s.tenantId, source: 'waitlist.match' },
    });
    expect(mails).toBe(1);
  });

  it('el repaso avisa a quien está en cola con trastero libre', async () => {
    const s = await setup('rrv-sweep');
    const w = await join(s.auth, s, 'Pau').expect(201);
    const { notified } = await app.get(WaitlistService).notifyWaitingWithFreeUnits();
    expect(notified).toBeGreaterThanOrEqual(1);
    const entry = await db.waitlistEntry.findUniqueOrThrow({ where: { id: w.body.id as string } });
    expect(entry.status).toBe('notified');
    expect(await unitStatus(s.unitIds[0]!)).toBe('reserved');
  });

  it('entradas cerradas, duplicados y tamaños que el local no tiene', async () => {
    const s = await setup('rrv-entries');
    const unitId = s.unitIds[0]!;
    const w = await join(s.auth, s, 'Mar').expect(201);
    const dup = await join(s.auth, s, 'Mar');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('waitlist_duplicate');

    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId });
    // Con un contrato en borrador sobre el trastero, sigue guardado.
    const customerId = await createCustomer(app, s.owner.accessToken);
    await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId, startDate: isoDay(1), priceMonthly: 50 })
      .expect(201);
    await http()
      .patch(`/waitlist/${w.body.id}`)
      .set(s.auth)
      .send({ status: 'converted' })
      .expect(200);
    expect(await unitStatus(unitId)).toBe('reserved');
    const closed = await http()
      .patch(`/waitlist/${w.body.id}`)
      .set(s.auth)
      .send({ status: 'cancelled' });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('waitlist_entry_closed');

    const other = await createFacilityWithUnits(app, s.owner.accessToken, { unitsCount: 1 });
    const wrong = await http().post('/waitlist').set(s.auth).send({
      facilityId: other.facilityId,
      unitTypeId: s.unitTypeId,
      contactName: 'Sol',
      contactEmail: 'sol@example.com',
    });
    expect(wrong.status).toBe(400);
    const options = await http().get(`/public/waitlist/${s.owner.slug}/options`).expect(200);
    const byName = options.body.facilities as { id: string; unitTypes: { id: string }[] }[];
    expect(byName.find((f) => f.id === other.facilityId)?.unitTypes.map((t) => t.id)).toEqual([
      other.unitTypeId,
    ]);
    const publicWrong = await http().post(`/public/waitlist/${s.owner.slug}`).send({
      facilityId: other.facilityId,
      unitTypeId: s.unitTypeId,
      contactName: 'Sol',
      contactEmail: 'sol@example.com',
    });
    expect(publicWrong.status).toBe(404);
  });

  it('el contrato sobre otro trastero suelta el guardado y lo ofrece al siguiente', async () => {
    const s = await setup('rrv-other', 2);
    const [held, chosen] = [s.unitIds[0]!, s.unitIds[1]!];
    const first = await join(s.auth, s, 'Rut').expect(201);
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: held });
    await join(s.auth, s, 'Gil').expect(201);
    const customerId = await createCustomer(app, s.owner.accessToken);
    await http()
      .post('/contracts')
      .set(s.auth)
      .send({
        customerId,
        unitId: chosen,
        startDate: isoDay(1),
        priceMonthly: 50,
        waitlistEntryId: first.body.id,
      })
      .expect(201);
    await new Promise((ok) => setTimeout(ok, 400));
    const entry = await db.waitlistEntry.findUniqueOrThrow({
      where: { id: first.body.id as string },
    });
    expect(entry.status).toBe('converted');
    expect(entry.heldUnitId).toBeNull();
    const gil = await db.waitlistEntry.findFirstOrThrow({
      where: { tenantId: s.tenantId, contactName: 'Gil' },
    });
    expect(gil.status).toBe('notified');
    expect(gil.heldUnitId).toBe(held);
  });

  it('reservas: fechas, señal sin inquilino y firma sobre una reserva sin inquilino', async () => {
    const s = await setup('rrv-resv');
    const unitId = s.unitIds[0]!;
    const past = await reserve(s.auth, unitId, {
      validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
      validUntil: new Date(Date.now() - DAY).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('invalid_valid_until');
    const noCustomer = await reserve(s.auth, unitId, { depositAmount: 20 });
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.code).toBe('customer_required');

    await reserve(s.auth, unitId).expect(201);
    const customerId = await createCustomer(app, s.owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId, startDate: isoDay(1), priceMonthly: 50 })
      .expect(201);
    const sign = await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({});
    expect(sign.status).toBe(409);
    expect(sign.body.code).toBe('unit_reserved_for_other');
  });

  it('una reserva vencida no se confirma', async () => {
    const s = await setup('rrv-late');
    const r = await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId: s.unitIds[0],
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + DAY).toISOString(),
      })
      .expect(201);
    await db.reservation.update({
      where: { id: r.body.id as string },
      data: {
        validFrom: new Date(Date.now() - 2 * DAY),
        validUntil: new Date(Date.now() - DAY),
      },
    });
    const res = await http().post(`/reservations/${r.body.id}/confirm`).set(s.auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reservation_expired');
  });

  it('peticiones del portal: fecha, repetidas, vacías y respuesta por correo', async () => {
    const s = await setup('rrv-portal', 3);
    const email = `rrv-portal-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, s.owner.accessToken, { email });
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: s.unitIds[0], startDate: isoDay(-30), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({}).expect(200);
    const pAuth = await portalAuth(s.owner.slug, email);
    const body = { contractId: c.body.id, targetUnitId: s.unitIds[1], note: '' };

    const bad = await http()
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ ...body, desiredDate: '2026-13-45' });
    expect(bad.status).toBe(400);
    const pastDate = await http()
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ ...body, desiredDate: isoDay(-3) });
    expect(pastDate.status).toBe(400);

    const change = await http()
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ ...body, desiredDate: isoDay(5) })
      .expect(201);
    const repeated = await http()
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ ...body, desiredDate: isoDay(5) });
    expect(repeated.status).toBe(409);

    const noReason = await http()
      .patch(`/unit-change-requests/${change.body.id}`)
      .set(s.auth)
      .send({ status: 'rejected' });
    expect(noReason.status).toBe(400);
    await http()
      .patch(`/unit-change-requests/${change.body.id}`)
      .set(s.auth)
      .send({ status: 'rejected', resolutionNote: 'No hay hueco esa semana' })
      .expect(200);
    const mail = await waitForEmail(email, { subjectIncludes: 'cambio de trastero' });
    expect(mail.Text).toContain('No hay hueco esa semana');

    const empty = await http().post('/portal/me/unit-requests').set(pAuth).send({ note: '' });
    expect(empty.status).toBe(400);
    const wanted = await http()
      .post('/portal/me/unit-requests')
      .set(pAuth)
      .send({ note: 'Necesito otro más grande' })
      .expect(201);
    const twice = await http()
      .post('/portal/me/unit-requests')
      .set(pAuth)
      .send({ note: 'Necesito otro más grande' });
    expect(twice.status).toBe(409);

    // El contrato que la atiende la cierra y se lo cuenta al inquilino.
    await http()
      .post('/contracts')
      .set(s.auth)
      .send({
        customerId,
        unitId: s.unitIds[2],
        startDate: isoDay(1),
        priceMonthly: 50,
        unitRequestId: wanted.body.id,
      })
      .expect(201);
    const closed = await db.unitRequest.findUniqueOrThrow({
      where: { id: wanted.body.id as string },
    });
    expect(closed.status).toBe('handled');
    await waitForEmail(email, { subjectIncludes: 'solicitud de trastero' });

    // Terminar el contrato cierra lo que quedaba pendiente sobre él.
    const open = await http()
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ contractId: c.body.id, note: 'Quiero uno más pequeño' })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/end`).set(s.auth).send({}).expect(200);
    const after = await db.unitChangeRequest.findUniqueOrThrow({
      where: { id: open.body.id as string },
    });
    expect(after.status).toBe('rejected');
  }, 60_000);

  it('anonimizar a un inquilino lo saca de la cola y suelta su trastero', async () => {
    const s = await setup('rrv-rgpd');
    const unitId = s.unitIds[0]!;
    const customerId = await createCustomer(app, s.owner.accessToken);
    const w = await http()
      .post('/waitlist')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        customerId,
        contactName: 'Ona',
        contactEmail: 'ona@example.com',
      })
      .expect(201);
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId });
    await http().post(`/rgpd/customers/${customerId}/anonymize`).set(s.auth).send({}).expect(204);
    const entry = await db.waitlistEntry.findUniqueOrThrow({ where: { id: w.body.id as string } });
    expect(entry.status).toBe('cancelled');
    expect(await unitStatus(unitId)).toBe('available');
  });
});
