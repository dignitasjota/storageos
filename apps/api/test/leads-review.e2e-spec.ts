import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { LeadCrmService } from '../src/modules/leads/lead-crm.service';
import { LeadsService } from '../src/modules/leads/leads.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Leads, Seguimientos y Oportunidades: validación, alcance por
 * local, conversión, bajas comerciales, repetidos, reserva online, tiempos de
 * respuesta, borrado de datos y oportunidades.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

describe('Revisión de leads, seguimientos y oportunidades (e2e)', () => {
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

  it('validación, otra empresa, búsqueda, vaciar campos y nombre', async () => {
    const owner = await registerVerifiedUser(app, 'lrva');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Filtros y fechas imposibles: 400, no 500.
    await http().get('/leads?status=foo').set(auth).expect(400);
    await http().get('/leads?assignedToUserId=abc').set(auth).expect(400);
    await http().get('/leads/page?status=foo').set(auth).expect(400);
    await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'X', preferredStartDate: '2026-13-45' })
      .expect(400);
    await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'W',
        email: `w-${Date.now()}@e2e.local`,
        phone: '600000001',
        hp: '',
        acceptsTerms: true,
        preferredStartDate: '2026-02-31',
      })
      .expect(400);

    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'manual',
        firstName: 'Ana',
        lastName: 'García',
        email: `ana-${Date.now()}@e2e.local`,
        phone: '600 111 222',
        budgetMonthly: 50,
      })
      .expect(201);
    await http()
      .post(`/leads/${lead.body.id}/followups`)
      .set(auth)
      .send({ title: 'Llamar', dueDate: '2026-13-45' })
      .expect(400);

    // Búsqueda por palabras.
    const found = await http().get('/leads?search=Ana%20Garc%C3%ADa').set(auth).expect(200);
    expect(found.body.map((l: { id: string }) => l.id)).toContain(lead.body.id);

    // Datos de otra empresa: rechazados.
    const other = await registerVerifiedUser(app, 'lrvb');
    const foreignCustomer = await createCustomer(app, other.accessToken);
    const foreignFacility = await createFacilityWithUnits(app, other.accessToken, {
      unitsCount: 1,
    });
    const noLocal = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Y', preferredFacilityId: foreignFacility.facilityId });
    expect(noLocal.status).toBe(400);
    expect(noLocal.body.code).toBe('facility_not_found');
    const noUser = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Z', assignedToUserId: other.userId });
    expect(noUser.body.code).toBe('user_not_found');
    const cross = await http()
      .post(`/leads/${lead.body.id}/convert`)
      .set(auth)
      .send({ customerId: foreignCustomer });
    expect(cross.status).toBe(404);

    // Vaciar campos y quitar el responsable.
    await http()
      .patch(`/leads/${lead.body.id}`)
      .set(auth)
      .send({ assignedToUserId: owner.userId })
      .expect(200);
    const cleared = await http()
      .patch(`/leads/${lead.body.id}`)
      .set(auth)
      .send({ email: null, phone: '', budgetMonthly: null, assignedToUserId: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      email: null,
      phone: null,
      budgetMonthly: null,
      assignedToUserId: null,
    });

    // Sin nombre: se enseña su teléfono.
    const wa = await app.get(LeadsService).createFromWhatsapp({
      tenantId: owner.tenantId,
      phone: '34699000111',
      name: null,
      message: 'Hola',
    });
    const waLead = await http().get(`/leads/${wa.id}`).set(auth).expect(200);
    expect(waLead.body.displayName).toBe('34699000111');

    // Una fecha deseada ya pasada no puntúa como urgente.
    const old = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Pasado', preferredStartDate: '2024-01-01' })
      .expect(201);
    expect(old.body.scoreReasons).not.toContain('Lo necesita en menos de un mes');
  });

  it('conversión, bajas comerciales, fusión, repetidos y tiempos de respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'lrvc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mk = async (body: Record<string, unknown>) =>
      (
        await http()
          .post('/leads')
          .set(auth)
          .send({ source: 'manual', ...body })
          .expect(201)
      ).body as { id: string };

    // Doble clic en «A cliente»: un solo inquilino.
    const doble = await mk({ firstName: 'Doble', lastName: `Conv${Date.now()}` });
    const [c1, c2] = await Promise.all([
      http().post(`/leads/${doble.id}/convert`).set(auth).send({}),
      http().post(`/leads/${doble.id}/convert`).set(auth).send({}),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([201, 409]);
    expect(
      await db.customer.count({ where: { tenantId: owner.tenantId, firstName: 'Doble' } }),
    ).toBe(1);

    // La baja comercial pasa al inquilino y se mantiene al fusionar.
    const baja = await mk({ firstName: 'Baja', email: `baja-${Date.now()}@e2e.local` });
    await http().post(`/leads/${baja.id}/marketing`).set(auth).send({ consent: false }).expect(200);
    const conv = await http().post(`/leads/${baja.id}/convert`).set(auth).send({}).expect(201);
    const cust = await db.customer.findUnique({ where: { id: conv.body.convertedCustomerId } });
    expect(cust?.marketingOptOutAt).not.toBeNull();

    const mail = `fus-${Date.now()}@e2e.local`;
    const target = await mk({ firstName: 'Destino', email: mail, marketingConsent: true });
    const source = await mk({ firstName: 'Origen', email: mail, marketingConsent: true });
    await http()
      .post(`/leads/${source.id}/marketing`)
      .set(auth)
      .send({ consent: false })
      .expect(200);
    await http()
      .post(`/leads/${source.id}/merge`)
      .set(auth)
      .send({ intoLeadId: target.id })
      .expect(204);
    expect(
      (await db.lead.findUnique({ where: { id: target.id } }))?.marketingOptOutAt,
    ).not.toBeNull();

    // Un perdido que se convierte deja de tener motivo de pérdida; enlazarlo
    // después con otro inquilino no pisa el enlace.
    const lost = await mk({ firstName: 'Perdido', email: `per-${Date.now()}@e2e.local` });
    await http()
      .post(`/leads/${lost.id}/followups`)
      .set(auth)
      .send({ title: 'Llamar al perdido', dueDate: '2026-01-01' })
      .expect(201);
    await http()
      .post(`/leads/${lost.id}/transition`)
      .set(auth)
      .send({ status: 'lost', lostReasonCode: 'too_expensive' })
      .expect(201);
    const pending = await http().get('/leads/followups/pending').set(auth).expect(200);
    expect(pending.body.map((f: { title: string }) => f.title)).not.toContain('Llamar al perdido');
    await http().post(`/leads/${lost.id}/convert`).set(auth).send({}).expect(201);
    const lostAfter = await db.lead.findUnique({ where: { id: lost.id } });
    expect(lostAfter).toMatchObject({ status: 'won', lostAt: null, lostReasonCode: null });
    const another = await createCustomer(app, owner.accessToken);
    const relink = await http()
      .post(`/leads/${lost.id}/link-customer`)
      .set(auth)
      .send({ customerId: another });
    expect(relink.status).toBe(409);

    // Fase no permitida: mensaje legible.
    const fase = await mk({ firstName: 'Fase' });
    const bad = await http().post(`/leads/${fase.id}/transition`).set(auth).send({ status: 'won' });
    expect(bad.status).toBe(409);

    // Repetido por teléfono con otro formato: se suma y avisa.
    const w1 = await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Tel',
        email: `tel1-${Date.now()}@e2e.local`,
        phone: '600 555 444',
        hp: '',
        acceptsTerms: true,
      })
      .expect(201);
    const w2 = await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Tel',
        email: `tel2-${Date.now()}@e2e.local`,
        phone: '+34600555444',
        hp: '',
        acceptsTerms: true,
        message: '¿Me llamáis?',
      })
      .expect(201);
    expect(w2.body.id).toBe(w1.body.id);
    expect(w2.body.returnedAt).not.toBeNull();
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'lead.returned' },
      }),
    ).toBe(1);

    // Reparto: el aviso es para quien lo recibe.
    await http().put('/leads/settings').set(auth).send({ autoAssign: 'round_robin' }).expect(200);
    await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Reparto',
        email: `rep-${Date.now()}@e2e.local`,
        phone: '611222333',
        hp: '',
        acceptsTerms: true,
      })
      .expect(201);
    let assigned = null;
    for (let i = 0; i < 20 && !assigned; i++) {
      assigned = await db.notification.findFirst({
        where: { tenantId: owner.tenantId, type: 'lead.assigned' },
      });
      if (!assigned) await sleep(200);
    }
    expect(assigned?.userId).toBe(owner.userId);
    await http().put('/leads/settings').set(auth).send({ autoAssign: 'off' }).expect(200);

    // La primera respuesta no se pisa al volver a «Contactado».
    const tiempos = await mk({ firstName: 'Tiempos' });
    await http()
      .post(`/leads/${tiempos.id}/transition`)
      .set(auth)
      .send({ status: 'contacted' })
      .expect(201);
    const firstAt = new Date(Date.now() - 5 * DAY);
    await db.lead.update({ where: { id: tiempos.id }, data: { contactedAt: firstAt } });
    await http()
      .post(`/leads/${tiempos.id}/transition`)
      .set(auth)
      .send({ status: 'qualified' })
      .expect(201);
    await http()
      .post(`/leads/${tiempos.id}/transition`)
      .set(auth)
      .send({ status: 'contacted' })
      .expect(201);
    expect((await db.lead.findUnique({ where: { id: tiempos.id } }))?.contactedAt).toEqual(firstAt);

    // Una llamada futura no cuenta; tras volver a «Nuevo», una llamada lo pasa a contactado.
    const fut = await mk({ firstName: 'Futuro' });
    const future = new Date(Date.now() + 10 * DAY).toISOString();
    const fa = await http()
      .post(`/leads/${fut.id}/activities`)
      .set(auth)
      .send({ type: 'call', content: 'x', occurredAt: future });
    expect(fa.body.code).toBe('occurred_in_future');
    await http().post(`/leads/${fut.id}/transition`).set(auth).send({ status: 'contacted' });
    await http().post(`/leads/${fut.id}/transition`).set(auth).send({ status: 'new' });
    await http()
      .post(`/leads/${fut.id}/activities`)
      .set(auth)
      .send({ type: 'call', content: 'Le llamo' })
      .expect(201);
    expect((await db.lead.findUnique({ where: { id: fut.id } }))?.status).toBe('contacted');
  });

  it('reserva online: se gana al firmar, vuelve si caduca y conserva su origen', async () => {
    const owner = await registerVerifiedUser(app, 'lrvd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    const facility = avail.body.facilities[0];
    const email = `book-${Date.now()}@e2e.local`;

    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'web',
        firstName: 'Reserva',
        email,
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'trasteros',
      })
      .expect(201);
    await http()
      .post(`/leads/${lead.body.id}/transition`)
      .set(auth)
      .send({ status: 'contacted' })
      .expect(201);

    // Deja el email en la reserva: no se crea otro contacto.
    await http()
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email, facilityId: facility.id, unitTypeId: facility.unitTypes[0].id })
      .expect(201);
    expect(await db.lead.count({ where: { tenantId: owner.tenantId, email } })).toBe(1);

    // Reserva con el enlace de un presupuesto: el origen sigue siendo Google.
    await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: new Date().toISOString().slice(0, 10),
        customer: {
          firstName: 'Reserva',
          lastName: 'Online',
          email,
          phone: '600777888',
          documentNumber: '12345678Z',
        },
        utmSource: 'presupuesto',
        utmMedium: 'email',
        utmCampaign: 'presupuesto',
      })
      .expect(201);
    const booked = await db.lead.findFirstOrThrow({ where: { tenantId: owner.tenantId, email } });
    expect(booked).toMatchObject({ status: 'qualified', utmSource: 'google' });
    expect(booked.bookedAt).not.toBeNull();
    expect(booked.convertedContractId).not.toBeNull();
    expect((booked.metadata as { bookingUtm?: { source: string } }).bookingUtm?.source).toBe(
      'presupuesto',
    );

    // Caduca sin firmar: vuelve a abierto con nota y aviso.
    await db.contract.updateMany({
      where: { tenantId: owner.tenantId },
      data: { firstPaymentDeadline: new Date(Date.now() - 3_600_000) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();
    let after = await db.lead.findFirstOrThrow({ where: { id: booked.id } });
    for (let i = 0; i < 20 && after.convertedCustomerId; i++) {
      await sleep(200);
      after = await db.lead.findFirstOrThrow({ where: { id: booked.id } });
    }
    expect(after).toMatchObject({ status: 'qualified', wonAt: null, convertedCustomerId: null });
    expect(after.message).toContain('caducó');
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'lead.booking_expired' },
      }),
    ).toBe(1);

    // La reserva sin atención no cuenta en los tiempos de respuesta.
    const stats = await http().get('/leads/response-stats?days=30').set(auth).expect(200);
    expect(stats.body.overall.leads).toBe(1);
  });

  it('alcance por local, seguimientos huérfanos, borrar datos y retención', async () => {
    const owner = await registerVerifiedUser(app, 'lrve');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const custA = await createCustomer(app, owner.accessToken, {
      firstName: 'Alcance',
      lastName: 'A',
    });
    const custB = await createCustomer(app, owner.accessToken, {
      firstName: 'Alcance',
      lastName: 'B',
      email: `dup-${Date.now()}@e2e.local`,
    });
    const a = await signedContractFor(app, owner.accessToken, { id: custA });
    const b = await signedContractFor(app, owner.accessToken, { id: custB });
    await http()
      .post(`/customers/${custA}/followups`)
      .set(auth)
      .send({ title: 'Seg A', dueDate: '2026-01-01' })
      .expect(201);
    const fb = await http()
      .post(`/customers/${custB}/followups`)
      .set(auth)
      .send({ title: 'Seg B', dueDate: '2026-01-01' })
      .expect(201);
    const leadB = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Lead B', preferredFacilityId: b.facilityId })
      .expect(201);
    await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'manual',
        firstName: 'Dup',
        email: (await db.customer.findUniqueOrThrow({ where: { id: custB } })).email,
      })
      .expect(201);

    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [a.facilityId],
      tag: 'lrvscope',
    });
    const inbox = await http().get('/followups').set(scoped).expect(200);
    expect(inbox.body.map((f: { title: string }) => f.title)).toEqual(['Seg A']);
    await http().patch(`/followups/${fb.body.id}`).set(scoped).send({ status: 'done' }).expect(404);
    await http().get(`/leads/${leadB.body.id}`).set(scoped).expect(404);
    const dups = await http().get('/leads/duplicates').set(scoped).expect(200);
    expect(
      dups.body.map((g: { customer: { name: string } | null }) => g.customer?.name ?? null),
    ).not.toContain('Alcance B');

    // Borrar un inquilino cancela sus seguimientos.
    const custC = await createCustomer(app, owner.accessToken, { firstName: 'Borrado' });
    await http()
      .post(`/customers/${custC}/followups`)
      .set(auth)
      .send({ title: 'Seg borrado', dueDate: '2026-01-01' })
      .expect(201);
    await http().delete(`/customers/${custC}`).set(auth).expect(204);
    const inbox2 = await http().get('/followups').set(auth).expect(200);
    expect(inbox2.body.map((f: { title: string }) => f.title)).not.toContain('Seg borrado');

    // Borrar un contacto borra sus datos.
    const gone = await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'manual',
        firstName: 'Olvido',
        email: `olv-${Date.now()}@e2e.local`,
        phone: '600999888',
      })
      .expect(201);
    await http()
      .post(`/leads/${gone.body.id}/activities`)
      .set(auth)
      .send({ type: 'call', content: 'Llamada' })
      .expect(201);
    await http().delete(`/leads/${gone.body.id}`).set(auth).expect(204);
    const wiped = await db.lead.findUniqueOrThrow({ where: { id: gone.body.id } });
    expect(wiped).toMatchObject({ email: null, phone: null });
    expect(wiped.deletedAt).not.toBeNull();
    expect(await db.leadActivity.count({ where: { leadId: gone.body.id } })).toBe(0);

    // Retención: un perdido sin actividad en el plazo se anonimiza.
    const stale = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Antiguo', email: `ant-${Date.now()}@e2e.local` })
      .expect(201);
    const longAgo = new Date(Date.now() - 400 * DAY);
    await db.lead.update({
      where: { id: stale.body.id },
      data: { status: 'lost', lostAt: longAgo },
    });
    await db.$executeRaw`UPDATE leads SET updated_at = ${longAgo} WHERE id = ${stale.body.id}::uuid`;
    await app.get(LeadCrmService).anonymizeStale();
    expect((await db.lead.findUniqueOrThrow({ where: { id: stale.body.id } })).email).toBeNull();
  });

  it('oportunidades: impago real, prueba, doble propuesta y WhatsApp', async () => {
    const owner = await registerVerifiedUser(app, 'lrvf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await db.goCardlessSettings.create({
      data: {
        tenantId: owner.tenantId,
        accessTokenEncrypted: 'x',
        webhookSecretEncrypted: 'x',
        enabled: true,
      },
    });
    const custA = await createCustomer(app, owner.accessToken, {
      email: `opp-${Date.now()}@e2e.local`,
    });
    const custTest = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: custA });
    await signedContractFor(app, owner.accessToken, { id: custTest });
    await db.customer.update({ where: { id: custTest }, data: { isTest: true } });

    // Paga a tiempo: no se dice que haya tenido facturas vencidas.
    const inv = await createDraftInvoice(app, owner.accessToken, custA, { unitPrice: 50 });
    await http().post(`/invoices/${inv}/issue`).set(auth).send({}).expect(200);
    await http()
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 60.5, methodType: 'cash' })
      .expect(200);
    const opps = await http().get('/opportunities').set(auth).expect(200);
    const autopay = opps.body.items.find(
      (o: { customerId: string; kind: string }) => o.customerId === custA && o.kind === 'autopay',
    );
    expect(autopay.reason).not.toContain('vencidas');
    expect(opps.body.items.some((o: { customerId: string }) => o.customerId === custTest)).toBe(
      false,
    );

    await http().get('/opportunities/draft?customerId=abc&kind=autopay').set(auth).expect(400);

    // Dos propuestas a la vez: una sola.
    const [p1, p2] = await Promise.all([
      http()
        .post('/opportunities/propose')
        .set(auth)
        .send({ customerId: custA, kind: 'autopay', followupInDays: 3 }),
      http()
        .post('/opportunities/propose')
        .set(auth)
        .send({ customerId: custA, kind: 'autopay', followupInDays: 3 }),
    ]);
    expect([p1.status, p2.status].sort()).toEqual([201, 409]);
    expect(
      await db.communication.count({
        where: { tenantId: owner.tenantId, customerId: custA, source: 'opportunity:autopay' },
      }),
    ).toBe(1);

    // Por WhatsApp: no envía correo pero queda como propuesta.
    await db.customerOffer.deleteMany({ where: { tenantId: owner.tenantId } });
    await http()
      .post('/opportunities/propose')
      .set(auth)
      .send({ customerId: custA, kind: 'autopay', followupInDays: 0, channel: 'whatsapp' })
      .expect(201);
    const again = await http().get('/opportunities').set(auth).expect(200);
    const mine = again.body.items.find(
      (o: { customerId: string; kind: string }) => o.customerId === custA && o.kind === 'autopay',
    );
    expect(mine.lastProposedAt).not.toBeNull();
    expect(
      await db.communication.count({
        where: { tenantId: owner.tenantId, customerId: custA, source: 'opportunity:autopay' },
      }),
    ).toBe(1);
  });
});
