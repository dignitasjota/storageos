import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { hashHoldToken } from '../src/common/waitlist-hold';
import { ReservationsService } from '../src/modules/contracts/reservations.service';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras de reservas, lista de espera y peticiones de trastero. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Mejoras de reservas y lista de espera (e2e)', () => {
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
      })
      .expect(201);

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

  it('dice quién retiene cada trastero', async () => {
    const s = await setup('rft-hold', 2);
    await join(s.auth, s, 'Ana');
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: s.unitIds[0]! });
    const customerId = await createCustomer(app, s.owner.accessToken);
    await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId: s.unitIds[1],
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);

    const one = await http().get(`/units/${s.unitIds[0]}/hold`).set(s.auth).expect(200);
    expect(one.body.hold.kind).toBe('waitlist');
    expect(one.body.hold.name).toBe('Ana');
    const held = await http().get('/reservations/held-units').set(s.auth).expect(200);
    const kinds = (held.body as { hold: { kind: string } }[]).map((u) => u.hold.kind).sort();
    expect(kinds).toEqual(['reservation', 'waitlist']);
    const floor = await http().get(`/floors/${s.floorId}/holds`).set(s.auth).expect(200);
    expect(floor.body).toHaveLength(2);
  });

  it('prorroga, recuerda antes de caducar y decide qué pasa con la señal', async () => {
    const s = await setup('rft-resv');
    const email = `rft-resv-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, s.owner.accessToken, { email });
    const r = await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId: s.unitIds[0],
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    await waitForEmail(email, { subjectIncludes: 'Te guardamos' });

    const id = r.body.id as string;
    await db.reservation.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 3 * DAY) },
    });
    expect(await app.get(ReservationsService).sendExpiryReminders()).toBeGreaterThanOrEqual(1);
    await waitForEmail(email, { subjectIncludes: 'a punto de caducar' });
    expect(await app.get(ReservationsService).sendExpiryReminders()).toBe(0);

    const newUntil = new Date(Date.now() + 20 * DAY).toISOString();
    const edited = await http()
      .patch(`/reservations/${id}`)
      .set(s.auth)
      .send({ validUntil: newUntil, notes: 'Vuelve de viaje' })
      .expect(200);
    expect(edited.body.notes).toBe('Vuelve de viaje');
    const row = await db.reservation.findUniqueOrThrow({ where: { id } });
    expect(row.reminderSentAt).toBeNull();
    const past = await http()
      .patch(`/reservations/${id}`)
      .set(s.auth)
      .send({ validUntil: new Date(Date.now() - DAY).toISOString() });
    expect(past.status).toBe(400);

    const settings = await http()
      .put('/reservations/settings')
      .set(s.auth)
      .send({ signalPolicy: 'keep', waitlistHoldHours: 24, waitlistStaleDays: 30 })
      .expect(200);
    expect(settings.body).toMatchObject({ signalPolicy: 'keep', waitlistHoldHours: 24 });
    const bad = await http()
      .put('/reservations/settings')
      .set(s.auth)
      .send({ waitlistHoldHours: 2 });
    expect(bad.status).toBe(400);
  });

  it('gestiona la cola: posición, avisar, ceder turno, volver y plazo del negocio', async () => {
    const s = await setup('rft-queue');
    await db.tenant.update({ where: { id: s.tenantId }, data: { waitlistHoldHours: 24 } });
    const unitId = s.unitIds[0]!;
    const first = await join(s.auth, s, 'Uno');
    const second = await join(s.auth, s, 'Dos');
    const list = async () =>
      (await http().get('/waitlist').set(s.auth).expect(200)).body as {
        id: string;
        status: string;
        position: number | null;
        freeUnitAvailable: boolean;
        holdExpiresAt: string | null;
      }[];
    expect((await list()).find((e) => e.id === first.body.id)?.position).toBe(1);
    expect((await list()).find((e) => e.id === second.body.id)?.freeUnitAvailable).toBe(true);
    const pending = await http().get('/waitlist/pending-count').set(s.auth).expect(200);
    expect(pending.body.count).toBe(1);

    // Ceder el turno sin nadie detrás no se puede; con alguien, pasa detrás.
    await http().post(`/waitlist/${first.body.id}/skip`).set(s.auth).expect(200);
    expect((await list()).find((e) => e.id === second.body.id)?.position).toBe(1);
    const last = await http().post(`/waitlist/${first.body.id}/skip`).set(s.auth);
    expect(last.status).toBe(409);

    // Avisar ahora a quien se elija, aunque no sea el primero.
    await http().post(`/waitlist/${first.body.id}/notify`).set(s.auth).expect(200);
    const notified = (await list()).find((e) => e.id === first.body.id)!;
    expect(notified.status).toBe('notified');
    const hours = (new Date(notified.holdExpiresAt!).getTime() - Date.now()) / 3_600_000;
    expect(Math.round(hours)).toBe(24);
    const none = await http().post(`/waitlist/${second.body.id}/notify`).set(s.auth);
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('no_free_unit');

    // Cede el turno ya avisado: el trastero pasa a la otra persona.
    await http().post(`/waitlist/${first.body.id}/skip`).set(s.auth).expect(200);
    const after = await list();
    expect(after.find((e) => e.id === second.body.id)?.status).toBe('notified');
    expect(after.find((e) => e.id === first.body.id)?.status).toBe('waiting');

    // Quien salió vuelve a su sitio.
    await http()
      .patch(`/waitlist/${first.body.id}`)
      .set(s.auth)
      .send({ status: 'cancelled' })
      .expect(200);
    await http().post(`/waitlist/${first.body.id}/requeue`).set(s.auth).expect(200);
    expect((await list()).find((e) => e.id === first.body.id)?.status).toBe('waiting');
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('reserved');
  }, 60_000);

  it('preasigna un trastero con baja pedida y se lo da a esa persona', async () => {
    const s = await setup('rft-pre');
    const unitId = s.unitIds[0]!;
    const c = await signed(s.auth, s.owner.accessToken, unitId);
    await join(s.auth, s, 'Primero');
    const wanted = await join(s.auth, s, 'Segundo');

    const notEnding = await http()
      .post(`/waitlist/${wanted.body.id}/preassign`)
      .set(s.auth)
      .send({ unitId });
    expect(notEnding.status).toBe(400);

    await http()
      .post(`/contracts/${c.id}/request-end`)
      .set(s.auth)
      .send({ endDate: isoDay(20) })
      .expect(200);
    const upcoming = await http()
      .get(`/waitlist/${wanted.body.id}/upcoming-units`)
      .set(s.auth)
      .expect(200);
    expect(upcoming.body).toHaveLength(1);
    await http()
      .post(`/waitlist/${wanted.body.id}/preassign`)
      .set(s.auth)
      .send({ unitId })
      .expect(200);

    await http().post(`/contracts/${c.id}/end`).set(s.auth).send({}).expect(200);
    await new Promise((ok) => setTimeout(ok, 400));
    const entry = await db.waitlistEntry.findUniqueOrThrow({
      where: { id: wanted.body.id as string },
    });
    expect(entry.status).toBe('notified');
    expect(entry.heldUnitId).toBe(unitId);
    const firstOne = await db.waitlistEntry.findFirstOrThrow({
      where: { tenantId: s.tenantId, contactName: 'Primero' },
    });
    expect(firstOne.status).toBe('waiting');
  });

  it('limpia la cola: pregunta, conserva a quien responde y saca al resto', async () => {
    const s = await setup('rft-stale');
    const svc = app.get(WaitlistService);
    // Sin hueco: la cola solo se mueve por el repaso de interés.
    await signed(s.auth, s.owner.accessToken, s.unitIds[0]!);
    const stays = await join(s.auth, s, 'Sigue');
    const leaves = await join(s.auth, s, 'Olvida');
    const old = new Date(Date.now() - 100 * DAY);
    await db.waitlistEntry.updateMany({
      where: { id: { in: [stays.body.id as string, leaves.body.id as string] } },
      data: { createdAt: old },
    });
    const { asked } = await svc.reviewStaleEntries();
    expect(asked).toBeGreaterThanOrEqual(2);
    expect((await svc.reviewStaleEntries()).asked).toBe(0);

    const token = 'token-de-prueba-interes';
    await db.waitlistEntry.update({
      where: { id: stays.body.id as string },
      data: { interestTokenHash: hashHoldToken(token) },
    });
    const view = await http().get(`/public/waitlist/interest/${token}`).expect(200);
    expect(view.body.closed).toBe(false);
    await http()
      .post(`/public/waitlist/interest/${token}`)
      .send({ stillInterested: true })
      .expect(204);
    await http().get(`/public/waitlist/interest/${token}`).expect(404);

    await db.waitlistEntry.update({
      where: { id: leaves.body.id as string },
      data: { interestAskedAt: new Date(Date.now() - 15 * DAY) },
    });
    await svc.reviewStaleEntries();
    const [a, b] = await Promise.all([
      db.waitlistEntry.findUniqueOrThrow({ where: { id: stays.body.id as string } }),
      db.waitlistEntry.findUniqueOrThrow({ where: { id: leaves.body.id as string } }),
    ]);
    expect(a.status).toBe('waiting');
    expect(a.interestAskedAt).toBeNull();
    expect(b.status).toBe('expired');

    const demand = await http().get('/waitlist/demand').set(s.auth).expect(200);
    expect(demand.body[0]).toMatchObject({ waiting: 1, freeUnits: 0, expired: 1 });
  });

  it('avisa al equipo de quien no responde', async () => {
    const s = await setup('rft-silent');
    const w = await join(s.auth, s, 'Calla');
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: s.unitIds[0]! });
    await db.waitlistEntry.update({
      where: { id: w.body.id as string },
      data: { notifiedAt: new Date(Date.now() - 2 * DAY) },
    });
    expect(await app.get(WaitlistService).alertNoReplies()).toBeGreaterThanOrEqual(1);
    const notice = await db.notification.count({
      where: { tenantId: s.tenantId, type: 'waitlist.no_reply' },
    });
    expect(notice).toBe(1);
    expect(await app.get(WaitlistService).alertNoReplies()).toBe(0);
  });

  it('con WhatsApp, el aviso de la cola sale también por ahí', async () => {
    const s = await setup('rft-wa');
    await setTenantFeatureOverride(s.owner.slug, 'whatsapp_business', true);
    await http()
      .put('/settings/whatsapp')
      .set(s.auth)
      .send({
        phoneNumberId: `5${Date.now()}`,
        accessToken: 'EAAG-token-de-prueba-555555',
        enabled: true,
      })
      .expect(200);
    await http()
      .put('/settings/whatsapp/assistant')
      .set(s.auth)
      .send({ reminderTemplateName: 'aviso_trastero' })
      .expect(200);
    await http()
      .post('/waitlist')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        contactName: 'Nora Vidal',
        contactEmail: 'nora@example.com',
        contactPhone: '600 111 222',
      })
      .expect(201);
    await app.get(WaitlistService).onUnitAvailable({ tenantId: s.tenantId, unitId: s.unitIds[0]! });
    await new Promise((ok) => setTimeout(ok, 400));
    const conversation = await db.whatsappConversation.findFirstOrThrow({
      where: { tenantId: s.tenantId, waId: '34600111222' },
      include: { messages: true },
    });
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]!.body).toContain('aviso_trastero');
  });

  it('bandeja de peticiones: reúne, asigna y da cifras', async () => {
    const s = await setup('rft-inbox', 2);
    const email = `rft-inbox-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, s.owner.accessToken, { email });
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: s.unitIds[0], startDate: isoDay(-30), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({}).expect(200);
    await db.unitChangeRequest.create({
      data: {
        tenantId: s.tenantId,
        customerId,
        contractId: c.body.id as string,
        note: 'Más grande',
      },
    });
    const req = await db.unitRequest.create({
      data: {
        tenantId: s.tenantId,
        customerId,
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        note: 'Otro igual',
      },
    });
    await join(s.auth, s, 'Hueco');

    const inbox = await http().get('/unit-inbox').set(s.auth).expect(200);
    expect(inbox.body.counts).toMatchObject({ change: 1, request: 1, waitlist: 1 });

    const me = await http().get('/auth/me').set(s.auth).expect(200);
    await http()
      .patch(`/unit-inbox/request/${req.id}/assign`)
      .set(s.auth)
      .send({ userId: me.body.user.id })
      .expect(204);
    const after = await http().get('/unit-inbox').set(s.auth).expect(200);
    const item = (after.body.items as { id: string; assignedToName: string | null }[]).find(
      (i) => i.id === req.id,
    );
    expect(item?.assignedToName).toBeTruthy();

    const alternatives = await db.unitChangeRequest.findFirstOrThrow({
      where: { tenantId: s.tenantId },
    });
    const alt = await http()
      .get(`/unit-change-requests/${alternatives.id}/alternatives`)
      .set(s.auth)
      .expect(200);
    expect(alt.body.map((u: { unitId: string }) => u.unitId)).toEqual([s.unitIds[1]]);

    await http().post(`/unit-requests/${req.id}/to-waitlist`).set(s.auth).send({}).expect(200);
    const queued = await db.waitlistEntry.findFirst({
      where: { tenantId: s.tenantId, customerId },
    });
    expect(queued?.status).toBe('waiting');
    await waitForEmail(email, { subjectIncludes: 'solicitud de trastero' });

    const stats = await http().get('/unit-inbox/stats?days=30').set(s.auth).expect(200);
    expect(stats.body.requestsAnswered).toBe(1);
  }, 60_000);
});
