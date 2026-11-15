import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { LeadNurtureService } from '../src/modules/leads/lead-nurture.service';
import { LeadQuotesService } from '../src/modules/leads/lead-quotes.service';
import { LeadVisitsService } from '../src/modules/leads/lead-visits.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Leads, Seguimientos y Oportunidades: filtros y totales,
 * cronología, presupuestos (WhatsApp, seguimiento y recordatorio), visitas,
 * respuestas por correo, secuencia automática, informe, importación, bandeja
 * de seguimientos y oportunidades nuevas, descartes y envío en bloque.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const INBOUND_SECRET = 'email-inbound-secret-e2e';
const INBOUND_DOMAIN = 'r.trasteros.test';
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * DAY);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
}

describe('Mejoras de leads, seguimientos y oportunidades (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.INBOUND_EMAIL_DOMAIN = INBOUND_DOMAIN;
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
    delete process.env.INBOUND_EMAIL_DOMAIN;
  });

  it('filtros, totales por fase, informe e importación', async () => {
    const owner = await registerVerifiedUser(app, 'lfa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 40,
    });
    const stamp = Date.now();
    await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'idealista',
        firstName: 'Ana',
        email: `ana-${stamp}@e2e.local`,
        preferredFacilityId: facilityId,
        preferredUnitTypeId: unitTypeId,
        budgetMonthly: 70,
      })
      .expect(201);
    await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Luis', preferredUnitTypeId: unitTypeId })
      .expect(201);

    const byFacility = await http().get(`/leads?facilityId=${facilityId}`).set(auth).expect(200);
    expect(byFacility.body).toHaveLength(1);
    const none = await http().get('/leads?facilityId=none').set(auth).expect(200);
    expect(none.body).toHaveLength(1);
    await http().get('/leads?facilityId=abc').set(auth).expect(400);
    await http().get('/leads?from=2026-02-31').set(auth).expect(400);
    const future = await http()
      .get(`/leads?from=${today(2)}`)
      .set(auth)
      .expect(200);
    expect(future.body).toHaveLength(0);

    // Totales: 2 nuevos; su valor = presupuesto (70) + precio del tamaño (40).
    const summary = await http().get('/leads/summary').set(auth).expect(200);
    expect(summary.body.byStatus.new).toEqual({ count: 2, value: 110 });
    const summaryIdealista = await http().get('/leads/summary?source=idealista').set(auth);
    expect(summaryIdealista.body.byStatus.new.count).toBe(1);

    const report = await http()
      .get(`/leads/report?from=${today(-30)}&to=${today()}`)
      .set(auth)
      .expect(200);
    expect(report.body.totals.leads).toBe(2);
    expect(report.body.bySource.map((r: { key: string }) => r.key).sort()).toEqual([
      'idealista',
      'manual',
    ]);
    await http()
      .get(`/leads/report?from=${today()}&to=${today(-3)}`)
      .set(auth)
      .expect(400);

    // Importación: plantilla, vista previa (uno repetido por email) y alta.
    const tpl = await http().get('/imports/leads/template').set(auth).expect(200);
    expect(tpl.body.csv).toContain('nombre');
    const csv = [
      'nombre,apellidos,email,telefono,origen,estado,fecha',
      `Pepa,López,pepa-${stamp}@e2e.local,600222333,Fotocasa,contactado,01/10/2026`,
      `Ana,,ana-${stamp}@e2e.local,,web,,`,
      `,,,,,,`,
      `Mal,,no-es-email,,,,`,
    ].join('\n');
    const preview = await http().post('/imports/leads/preview').set(auth).send({ csv }).expect(201);
    expect(preview.body.summary).toMatchObject({ valid: 1, duplicates: 1, invalid: 1 });
    const commit = await http()
      .post('/imports/leads/commit')
      .set(auth)
      .send({ csv, onDuplicate: 'skip' })
      .expect(201);
    expect(commit.body.summary.created).toBe(1);
    const pepa = await db.lead.findFirst({
      where: { tenantId: owner.tenantId, email: `pepa-${stamp}@e2e.local` },
    });
    expect(pepa).toMatchObject({ source: 'fotocasa', status: 'contacted', nurtureStep: 3 });
  });

  it('presupuesto por WhatsApp con seguimiento, recordatorio, visitas y cronología', async () => {
    const owner = await registerVerifiedUser(app, 'lfb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    const email = `quote-${Date.now()}@e2e.local`;
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Marta', email, phone: '600 333 444' })
      .expect(201);
    const leadId = lead.body.id as string;

    const sent = await http()
      .post(`/leads/${leadId}/quote/send`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 1, channel: 'whatsapp', followupInDays: 3 })
      .expect(201);
    expect(sent.body.sentTo).toBe('');
    expect(sent.body.whatsappText).toContain('reservarlo aquí');
    expect(sent.body.followupId).toBeTruthy();
    // Por WhatsApp no sale ningún correo.
    expect(await db.communication.count({ where: { leadId, source: 'lead.quote' } })).toBe(0);
    const quotes = await http().get(`/leads/${leadId}/quotes`).set(auth).expect(200);
    expect(quotes.body).toHaveLength(1);
    expect(quotes.body[0]).toMatchObject({ channel: 'whatsapp', months: 1 });
    const followup = await db.leadFollowup.findUnique({ where: { id: sent.body.followupId } });
    expect(followup?.dueDate.toISOString().slice(0, 10)).toBe(today(3));

    // Por correo: lleva la dirección propia del contacto para las respuestas.
    await http()
      .post(`/leads/${leadId}/quote/send`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 3, followupInDays: 0 })
      .expect(201);
    const quoteMail = await db.communication.findFirst({ where: { leadId, source: 'lead.quote' } });
    expect(quoteMail?.replyTo).toMatch(new RegExp(`^l-[a-f0-9]+@${INBOUND_DOMAIN}$`));

    // Recordatorio a los 3 días: solo el más reciente y una vez.
    await http().put('/leads/settings').set(auth).send({ quoteReminderDays: 3 }).expect(200);
    await db.leadQuote.updateMany({
      where: { leadId },
      data: { sentAt: new Date(Date.now() - 4 * DAY) },
    });
    const quotesSvc = app.get(LeadQuotesService);
    await quotesSvc.sendReminders();
    await quotesSvc.sendReminders();
    expect(await db.communication.count({ where: { leadId, source: 'lead.quote_reminder' } })).toBe(
      1,
    );

    // Contesta al correo: queda en su ficha y vuelve a «ha escrito».
    await http()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: email,
        to: [`Trasteros <${quoteMail!.replyTo as string}>`],
        text: 'Me interesa el de 3 meses\n\nEl lun, a las 10:12, Trasteros escribió:\n> Hola',
        dmarc: 'pass',
      })
      .expect(200);
    const reply = await db.leadActivity.findFirst({ where: { leadId, type: 'email_in' } });
    expect(reply?.content).toBe('Me interesa el de 3 meses');
    expect((await db.lead.findUnique({ where: { id: leadId } }))?.returnedAt).not.toBeNull();

    // Visita mañana: el contacto pasa a cualificado y sale en el calendario.
    const at = new Date(Date.now() + DAY);
    at.setUTCHours(10, 0, 0, 0);
    const visit = await http()
      .post(`/leads/${leadId}/visits`)
      .set(auth)
      .send({ scheduledAt: at.toISOString(), facilityId, notes: 'Con su hermano' })
      .expect(201);
    expect((await db.lead.findUnique({ where: { id: leadId } }))?.status).toBe('qualified');
    const cal = await http()
      .get(`/calendar?from=${today()}&to=${today(3)}`)
      .set(auth)
      .expect(200);
    const events = (cal.body.events ?? cal.body) as { type: string }[];
    expect(events.some((e) => e.type === 'lead_visit')).toBe(true);
    // Recordatorio al contacto el día antes (entre 20 y 28 h): una vez.
    await db.leadVisit.update({
      where: { id: visit.body.id },
      data: { scheduledAt: new Date(Date.now() + 24 * 3_600_000) },
    });
    await app.get(LeadVisitsService).sendReminders();
    await app.get(LeadVisitsService).sendReminders();
    expect(await db.communication.count({ where: { leadId, source: 'lead.visit_reminder' } })).toBe(
      1,
    );
    // Hecha: queda un seguimiento para mañana.
    await http()
      .patch(`/leads/visits/${visit.body.id}`)
      .set(auth)
      .send({ status: 'done' })
      .expect(200);
    expect(
      await db.leadFollowup.count({
        where: { leadId, title: 'Llamar tras la visita: ¿reserva?', status: 'pending' },
      }),
    ).toBe(1);

    const timeline = await http().get(`/leads/${leadId}/timeline`).set(auth).expect(200);
    const kinds = new Set((timeline.body as { kind: string }[]).map((i) => i.kind));
    for (const k of ['created', 'quote', 'email_out', 'email_in', 'visit', 'followup']) {
      expect(kinds.has(k)).toBe(true);
    }

    // Fusionar con un duplicado se lleva los presupuestos y las visitas;
    // borrar sus datos los borra.
    const dup = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Marta', phone: '600333444' })
      .expect(201);
    await http()
      .post(`/leads/${leadId}/merge`)
      .set(auth)
      .send({ intoLeadId: dup.body.id })
      .expect(204);
    expect((await http().get(`/leads/${dup.body.id}/quotes`).set(auth)).body).toHaveLength(2);
    expect((await http().get(`/leads/${dup.body.id}/visits`).set(auth)).body).toHaveLength(1);
    await http().delete(`/leads/${dup.body.id}`).set(auth).expect(204);
    expect(await db.leadQuote.count({ where: { leadId: dup.body.id } })).toBe(0);
    expect(await db.leadVisit.count({ where: { leadId: dup.body.id } })).toBe(0);
  });

  it('secuencia de correos a los contactos de la web y horario de atención', async () => {
    const owner = await registerVerifiedUser(app, 'lfc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 45 });
    const settings = await http()
      .put('/leads/settings')
      .set(auth)
      .send({ nurtureEnabled: true })
      .expect(200);
    expect(settings.body).toMatchObject({ nurtureEnabled: true, businessHoursConfigured: false });

    const email = `web-${Date.now()}@e2e.local`;
    await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({ firstName: 'Web', email, phone: '600999888', hp: '', acceptsTerms: true })
      .expect(201);
    const lead = await db.lead.findFirstOrThrow({ where: { tenantId: owner.tenantId, email } });
    // El primer correo sale al llegar (en segundo plano).
    for (let i = 0; i < 20; i++) {
      if (await db.communication.count({ where: { leadId: lead.id, source: 'lead.nurture_1' } }))
        break;
      await sleep(150);
    }
    const first = await db.communication.findFirstOrThrow({
      where: { leadId: lead.id, source: 'lead.nurture_1' },
    });
    // `formatEur` separa el importe del € con un espacio duro.
    expect(first.bodyText).toMatch(/desde 54,45\s€\/mes/);
    // A los 2 días, el segundo; luego, si lo atiende alguien, se para.
    await db.lead.update({
      where: { id: lead.id },
      data: { nurtureLastAt: new Date(Date.now() - 3 * DAY) },
    });
    await app.get(LeadNurtureService).runDue();
    expect((await db.lead.findUnique({ where: { id: lead.id } }))?.nurtureStep).toBe(2);
    await http()
      .post(`/leads/${lead.id}/activities`)
      .set(auth)
      .send({ type: 'call', content: 'Le he llamado' })
      .expect(201);
    expect((await db.lead.findUnique({ where: { id: lead.id } }))?.nurtureStep).toBe(3);

    // Horario de atención: sin horario no se puede activar de forma útil.
    await http().put('/leads/settings').set(auth).send({ useBusinessHours: true }).expect(200);
  });

  it('bandeja de seguimientos: pestañas, míos, resultado, posponer y número del menú', async () => {
    const owner = await registerVerifiedUser(app, 'lfd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'manual', firstName: 'Paco' })
      .expect(201);
    const cf = await http()
      .post(`/customers/${customerId}/followups`)
      .set(auth)
      .send({ title: 'Llamar para renovar', dueDate: today() })
      .expect(201);
    const lf = await http()
      .post(`/leads/${lead.body.id}/followups`)
      .set(auth)
      .send({ title: 'Mandar presupuesto', dueDate: today(-2) })
      .expect(201);
    await http()
      .post(`/customers/${customerId}/followups`)
      .set(auth)
      .send({ title: 'Revisar fianza', dueDate: today(5) })
      .expect(201);

    const inbox = await http().get('/followups/inbox?tab=today').set(auth).expect(200);
    expect(inbox.body.counts).toEqual({ today: 1, overdue: 1, upcoming: 1, done: 0 });
    expect(inbox.body.items[0]).toMatchObject({ kind: 'customer', title: 'Llamar para renovar' });
    const overdue = await http().get('/followups/inbox?tab=overdue').set(auth).expect(200);
    expect(overdue.body.items[0]).toMatchObject({ kind: 'lead', targetId: lead.body.id });
    expect((await http().get('/followups/due-count').set(auth)).body.due).toBe(2);
    const mine = await http().get('/followups/inbox?tab=today&mine=1').set(auth).expect(200);
    expect(mine.body.counts.today).toBe(1);

    // Hecho con resultado: queda en su ficha.
    await http()
      .patch(`/followups/${cf.body.id}`)
      .set(auth)
      .send({ status: 'done', outcome: 'Renueva un año' })
      .expect(200);
    const note = await db.customerInteraction.findFirst({ where: { customerId } });
    expect(note?.content).toContain('Renueva un año');
    // Posponer el del contacto a dentro de una semana.
    await http()
      .patch(`/leads/followups/${lf.body.id}`)
      .set(auth)
      .send({ dueDate: today(7) })
      .expect(200);
    await http().patch(`/leads/followups/${lf.body.id}`).set(auth).send({}).expect(400);
    await http()
      .patch(`/leads/followups/${lf.body.id}`)
      .set(auth)
      .send({ assignedToUserId: '00000000-0000-0000-0000-000000000000' })
      .expect(400);
    const after = await http().get('/followups/inbox?tab=done').set(auth).expect(200);
    expect(after.body.counts).toMatchObject({ today: 0, overdue: 0, upcoming: 2, done: 1 });
    expect(after.body.items[0].outcome).toBe('Renueva un año');
  });

  it('oportunidades: renovar, descartar, recuperar, en bloque y resultados', async () => {
    const owner = await registerVerifiedUser(app, 'lfe');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `opp-${Date.now()}@e2e.local`,
    });
    const { contractId } = await signedContractFor(app, owner.accessToken, { id: customerId });
    await db.contract.update({
      where: { id: contractId },
      data: { autoRenew: false, endDate: new Date(Date.now() + 20 * DAY) },
    });

    const list = await http().get('/opportunities').set(auth).expect(200);
    const kinds = (list.body.items as { kind: string; customerId: string }[])
      .filter((o) => o.customerId === customerId)
      .map((o) => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(['renewal', 'incomplete_data']));
    const renewal = list.body.items.find((o: { kind: string }) => o.kind === 'renewal');
    expect(renewal.facilityIds).toHaveLength(1);
    const draft = await http()
      .get(`/opportunities/draft?customerId=${customerId}&kind=renewal`)
      .set(auth)
      .expect(200);
    expect(draft.body.body).toContain('Tu contrato termina el');
    await http()
      .get(`/opportunities/draft?customerId=${customerId}&kind=foo`)
      .set(auth)
      .expect(400);

    // Posponer: sale de la lista y aparece en descartadas; recuperar la devuelve.
    await http()
      .post('/opportunities/dismiss')
      .set(auth)
      .send({ customerId, kind: 'incomplete_data', days: 30 })
      .expect(204);
    const after = await http().get('/opportunities').set(auth).expect(200);
    expect(
      after.body.items.some(
        (o: { kind: string; customerId: string }) =>
          o.customerId === customerId && o.kind === 'incomplete_data',
      ),
    ).toBe(false);
    const dismissed = await http().get('/opportunities/dismissed').set(auth).expect(200);
    expect(dismissed.body).toHaveLength(1);
    expect(dismissed.body[0].until).not.toBeNull();
    await http()
      .delete(`/opportunities/dismiss?customerId=${customerId}&kind=incomplete_data`)
      .set(auth)
      .expect(204);
    expect((await http().get('/opportunities/dismissed').set(auth)).body).toHaveLength(0);

    // En bloque: renovar sale; uno sin email se salta.
    const noEmail = await createCustomer(app, owner.accessToken);
    await db.customer.update({ where: { id: noEmail }, data: { email: null } });
    const bulk = await http()
      .post('/opportunities/propose-bulk')
      .set(auth)
      .send({
        items: [
          { customerId, kind: 'renewal' },
          { customerId: noEmail, kind: 'autopay' },
        ],
        followupInDays: 0,
      })
      .expect(201);
    expect(bulk.body.sent).toBe(1);
    expect(bulk.body.skipped).toEqual([
      { customerId: noEmail, kind: 'autopay', reason: 'No tiene email' },
    ]);
    const offer = await db.customerOffer.findFirstOrThrow({
      where: { customerId, kind: 'renewal' },
    });
    expect((offer.metadata as { contractId: string }).contractId).toBe(contractId);

    // «Me interesa» → número del menú; prorrogar el contrato → contratada.
    await db.customerOffer.update({ where: { id: offer.id }, data: { status: 'interested' } });
    expect((await http().get('/opportunities/interested-count').set(auth)).body.interested).toBe(1);
    await db.contract.update({
      where: { id: contractId },
      data: { endDate: new Date(Date.now() + 400 * DAY) },
    });
    const results = await http().get('/opportunities/results?days=30').set(auth).expect(200);
    expect(results.body.byKind.renewal).toMatchObject({ proposed: 1, accepted: 1 });
    expect((await http().get('/opportunities/interested-count').set(auth)).body.interested).toBe(0);
  });
});
