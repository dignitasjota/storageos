import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { currentMrrByTenant } from '../src/common/saas-metrics';
import { PlatformLeadsService } from '../src/modules/admin/leads/platform-leads.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { PlatformLeadDetailDto, PlatformLeadStatsDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `leads-review-super-${STAMP}@storageos.local`,
  repA: `leads-review-a-${STAMP}@storageos.local`,
  repB: `leads-review-b-${STAMP}@storageos.local`,
};
const DAY = 86_400_000;
const HOUR = 3_600_000;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const madridDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * DAY).toLocaleDateString('sv-SE', {
    timeZone: 'Europe/Madrid',
  });

/**
 * Revisión de los leads del panel admin: CSV sin fórmulas, duplicados al
 * editar, fechas, cartera de comerciales, perdidos que vuelven a escribir,
 * pruebas con cobro en curso, cifras de Resultados, tablero cortado,
 * descartados, seguimientos al perder, registro de acciones y propuestas que
 * no se envían.
 */
describe('Revisión de los leads del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let superId: string;
  let repAId: string;
  let repBId: string;
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function detail(id: string): Promise<PlatformLeadDetailDto> {
    const res = await http().get(`/admin/leads/${id}`).set(auth()).expect(200);
    return res.body as PlatformLeadDetailDto;
  }

  async function newLead(body: Record<string, unknown>): Promise<PlatformLeadDetailDto> {
    const res = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ source: 'phone', ...body })
      .expect(201);
    return res.body as PlatformLeadDetailDto;
  }

  /** Cuenta registrada en la web con el email de un lead (queda «En prueba»). */
  async function register(email: string, label: string): Promise<string> {
    await http()
      .post('/auth/register')
      .send({
        tenantName: `Trasteros ${label}`,
        tenantSlug: `test-lrv-${label}-${stamp()}`,
        fullName: 'Prueba Revisión',
        email,
        password: 'Secret123',
        acceptTerms: true,
      })
      .expect(201);
    const lead = await db.platformLead.findFirstOrThrow({ where: { email } });
    return lead.tenantId!;
  }

  async function stats(months = 3): Promise<PlatformLeadStatsDto> {
    const res = await http().get(`/admin/leads/stats?months=${months}`).set(auth()).expect(200);
    return res.body as PlatformLeadStatsDto;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    const sup = await db.superAdmin.create({
      data: {
        email: EMAILS.super,
        passwordHash,
        fullName: 'Dirección Revisión',
        role: 'superadmin',
      },
    });
    const a = await db.superAdmin.create({
      data: { email: EMAILS.repA, passwordHash, fullName: 'Ana Cartera', role: 'sales' },
    });
    const b = await db.superAdmin.create({
      data: { email: EMAILS.repB, passwordHash, fullName: 'Beto Cartera', role: 'sales' },
    });
    superId = sup.id;
    repAId = a.id;
    repBId = b.id;
    app = await createTestApp();
    const res = await http()
      .post('/admin/auth/login')
      .send({ email: EMAILS.super, password: PASSWORD });
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await db.platformLead.updateMany({
      where: { OR: [{ salesRepId: { in: [repAId, repBId] } }, { assignedToId: superId }] },
      data: { salesRepId: null, assignedToId: null },
    });
    await db.salesAssignment.deleteMany({ where: { repId: { in: [repAId, repBId] } } });
    await db.tenant.updateMany({
      where: { salesRepId: { in: [repAId, repBId] } },
      data: { salesRepId: null },
    });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('el CSV neutraliza los textos que Excel tomaría por fórmulas', async () => {
    const s = stamp();
    await newLead({
      companyName: `=HYPERLINK("http://malo.example","pulsa") ${s}`,
      contactName: '+34 Persona',
      city: '@SUM(1+1)',
      email: `csv-${s}@e2e.local`,
    });
    const csv = await http()
      .get(`/admin/leads/export.csv?search=${encodeURIComponent(s)}`)
      .set(auth())
      .expect(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://malo.example"",""pulsa"") ${s}"`);
    expect(csv.text).toContain("'+34 Persona");
    expect(csv.text).toContain("'@SUM(1+1)");
    expect(csv.text).not.toMatch(/;=HYPERLINK/);
  });

  it('editar un lead con el email o el teléfono de otro da 409', async () => {
    const s = stamp();
    const a = await newLead({
      contactName: 'Uno',
      email: `dup-a-${s}@e2e.local`,
      phone: `+34 6${String(Date.now()).slice(-8)}`,
    });
    const b = await newLead({ contactName: 'Dos', email: `dup-b-${s}@e2e.local` });
    const byEmail = await http()
      .patch(`/admin/leads/${b.id}`)
      .set(auth())
      .send({ email: a.email!.toUpperCase() })
      .expect(409);
    expect(byEmail.body).toMatchObject({ code: 'lead_exists', details: { leadId: a.id } });
    const byPhone = await http()
      .patch(`/admin/leads/${b.id}`)
      .set(auth())
      .send({ phone: a.phone!.replace(/\D/g, '').slice(-9) })
      .expect(409);
    expect(byPhone.body.details.leadId).toBe(a.id);
    // Guardar su propio email (sin cambios) u otros datos no choca consigo mismo.
    await http()
      .patch(`/admin/leads/${a.id}`)
      .set(auth())
      .send({ email: a.email, city: 'Valencia' })
      .expect(200);
  });

  it('fechas reales y no pasadas; actividades no futuras y primera respuesta con su fecha', async () => {
    const s = stamp();
    const lead = await newLead({ contactName: 'Fechas', email: `fechas-${s}@e2e.local` });
    const bad = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Llamar', dueDate: '2026-02-31' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_date');
    const past = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Llamar', dueDate: madridDay(-1) })
      .expect(400);
    expect(past.body.code).toBe('date_in_past');
    const ok = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Llamar hoy', dueDate: madridDay(0) })
      .expect(201);
    const followup = ok.body.followups[0];
    const pastMove = await http()
      .patch(`/admin/leads/followups/${followup.id}`)
      .set(auth())
      .send({ dueDate: madridDay(-2) })
      .expect(400);
    expect(pastMove.body.code).toBe('date_in_past');
    const lose = await http()
      .post(`/admin/leads/${lead.id}/lose`)
      .set(auth())
      .send({ reasonCode: 'price', recontactOn: '2027-13-01' })
      .expect(400);
    expect(lose.body.code).toBe('invalid_date');

    const future = await http()
      .post(`/admin/leads/${lead.id}/activities`)
      .set(auth())
      .send({
        type: 'call',
        content: 'Llamada del futuro',
        occurredAt: new Date(Date.now() + HOUR).toISOString(),
      })
      .expect(400);
    expect(future.body.code).toBe('date_in_future');

    // Lleva 5 h dado de alta; la llamada fue hace 2 h: esa es su primera respuesta.
    await db.platformLead.update({
      where: { id: lead.id },
      data: { createdAt: new Date(Date.now() - 5 * HOUR) },
    });
    const callAt = new Date(Date.now() - 2 * HOUR);
    const called = await http()
      .post(`/admin/leads/${lead.id}/activities`)
      .set(auth())
      .send({ type: 'call', content: 'Le llamé', occurredAt: callAt.toISOString() })
      .expect(201);
    expect(called.body.status).toBe('contacted');
    expect(new Date(called.body.firstResponseAt).getTime()).toBe(callAt.getTime());
    expect(new Date(called.body.contactedAt).getTime()).toBe(callAt.getTime());
    expect(called.body.awaitingReplySince).toBeNull();
  });

  it('reasignar en el tablero mueve la cartera salvo si la cuenta ya es cliente del comercial', async () => {
    const s = stamp();
    const lead = await newLead({
      companyName: `Cartera ${s}`,
      email: `cartera-${s}@e2e.local`,
      assignedToId: repAId,
    });
    expect((await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } })).salesRepId).toBe(
      repAId,
    );
    // A un admin que no es comercial: sale de la cartera de Ana.
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: superId })
      .expect(200);
    let row = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({ salesRepId: null, assignedToId: superId });
    expect(await db.salesAssignment.count({ where: { leadId: lead.id, endedAt: null } })).toBe(0);
    // A otro comercial: pasa a su cartera.
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: repBId })
      .expect(200);
    row = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.salesRepId).toBe(repBId);
    // Sin responsable: sale de la cartera.
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: null })
      .expect(200);
    row = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.salesRepId).toBeNull();

    // Excepción: su cuenta ya es cliente de Beto. Reasignar no toca la cartera.
    const tenantId = await register(lead.email!, 'cartera');
    await db.tenant.update({ where: { id: tenantId }, data: { salesRepId: repBId } });
    await db.platformLead.update({
      where: { id: lead.id },
      data: { salesRepId: repBId, assignedToId: repBId },
    });
    const kept = await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: superId })
      .expect(200);
    expect(kept.body.accountKeptBy).toEqual({ id: repBId, name: 'Beto Cartera' });
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: repAId })
      .expect(200);
    row = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row).toMatchObject({ salesRepId: repBId, assignedToId: repAId });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).salesRepId).toBe(
      repBId,
    );
  });

  it('un perdido que vuelve a escribir cuenta como sin atender desde el mensaje nuevo', async () => {
    const leads = app.get(PlatformLeadsService);
    const email = `vuelve-${stamp()}@e2e.local`;
    const event = {
      contactMessageId: '00000000-0000-0000-0000-000000000000',
      source: 'web_contact' as const,
      name: 'Vuelve',
      email,
      phone: null,
      company: 'Trasteros Vuelve',
      units: null,
      profile: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
    };
    const id = await leads.ingestContact({ ...event, message: 'Primer mensaje' });
    await http()
      .post(`/admin/leads/${id}/activities`)
      .set(auth())
      .send({ type: 'call', content: 'Hablado' })
      .expect(201);
    await http()
      .post(`/admin/leads/${id}/lose`)
      .set(auth())
      .send({ reasonCode: 'not_now' })
      .expect(200);
    const firstResponse = new Date(Date.now() - 9 * DAY);
    await db.platformLead.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 10 * DAY), firstResponseAt: firstResponse },
    });
    await leads.ingestContact({ ...event, message: 'Os vuelvo a escribir' });
    const back = await detail(id);
    expect(back.status).toBe('new');
    expect(back.firstResponseAt).toBe(firstResponse.toISOString());
    expect(Date.now() - new Date(back.awaitingReplySince!).getTime()).toBeLessThan(60_000);

    // El aviso cuenta desde el mensaje nuevo (hace 5 h), no desde el alta (hace 10 días).
    await db.platformLead.update({
      where: { id },
      data: { awaitingReplySince: new Date(Date.now() - 5 * HOUR) },
    });
    const notified = (await leads.unattended()).find((u) => u.id === id);
    expect(notified?.hours).toBe(5);
    const today = await http().get('/admin/today').set(auth()).expect(200);
    const inToday = (today.body.newLeads as { id: string; waitingHours: number }[]).find(
      (l) => l.id === id,
    );
    if (inToday) expect(inToday.waitingHours).toBe(5);
  });

  it('prueba terminada: margen, cobro en curso, pierde, paga, se da de baja y vuelve', async () => {
    const leads = app.get(PlatformLeadsService);
    const email = `prueba-${stamp()}@e2e.local`;
    const lead = await newLead({ companyName: 'Trasteros Prueba Revisión', email });
    const tenantId = await register(email, 'prueba');
    const pending = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Llamar por la prueba', dueDate: madridDay(1) })
      .expect(201);
    const pendingId = pending.body.followups[0].id as string;
    const status = async () => (await detail(lead.id)).status;

    // Dentro del margen de 7 días: sigue en prueba.
    await db.tenant.update({
      where: { id: tenantId },
      data: { status: 'active', trialEndedAt: new Date(Date.now() - 3 * DAY) },
    });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'expired' } });
    await leads.syncFromTenants();
    expect(await status()).toBe('trial');

    // Pasado el margen pero con la suscripción activa de un plan de pago: va a pagar.
    await db.tenant.update({
      where: { id: tenantId },
      data: { trialEndedAt: new Date(Date.now() - 10 * DAY) },
    });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'active' } });
    await leads.syncFromTenants();
    expect(await status()).toBe('trial');

    // En solo lectura pero con un cobro en marcha: tampoco.
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'expired' } });
    const charge = await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'stripe', status: 'pending', amount: 79, currency: 'EUR' },
    });
    await leads.syncFromTenants();
    expect(await status()).toBe('trial');

    // Sin cobro: perdido, con lo pendiente cerrado y el «volver a contactar».
    await db.tenantSubscriptionPayment.delete({ where: { id: charge.id } });
    await leads.syncFromTenants();
    let row = await detail(lead.id);
    expect(row).toMatchObject({ status: 'lost', lostReasonCode: 'no_conversion' });
    expect(row.followups.find((f) => f.id === pendingId)?.status).toBe('done');
    const recontact = row.followups.find((f) => f.title.startsWith('Volver a contactar'));
    expect(recontact?.status).toBe('pending');

    // Paga: cliente, y el «volver a contactar» automático se cierra.
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 79,
        currency: 'EUR',
        paidAt: new Date(),
      },
    });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'active' } });
    await leads.syncFromTenants();
    row = await detail(lead.id);
    expect(row.status).toBe('customer');
    expect(row.followups.find((f) => f.id === recontact!.id)?.status).toBe('done');

    // Se da de baja: «Cliente que se dio de baja», contado aparte en Resultados.
    const before = await stats();
    await db.tenant.update({ where: { id: tenantId }, data: { status: 'cancelled' } });
    const moved = await leads.syncFromTenants();
    expect(moved.churned).toBeGreaterThanOrEqual(1);
    row = await detail(lead.id);
    expect(row).toMatchObject({ status: 'lost', lostReasonCode: 'churned' });
    const after = await stats();
    expect(after.churned).toBe(before.churned + 1);
    expect(after.lost).toBe(before.lost);
    expect(after.lostReasons.some((r) => (r.code as string) === 'churned')).toBe(false);

    // Vuelve a estar activo y pagando: otra vez cliente.
    await db.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    await leads.syncFromTenants();
    expect(await status()).toBe('customer');
  });

  it('Resultados: registros directos aparte, primera respuesta sin altas manuales y MRR sin IVA', async () => {
    const leads = app.get(PlatformLeadsService);
    const before = await stats();
    // Registro directo (sin lead previo): entra en prueba, no en el embudo.
    const email = `directo-${stamp()}@e2e.local`;
    const tenantId = await register(email, 'directo');
    // Alta manual respondida muy tarde: no cuenta en la mediana.
    const manual = await newLead({ contactName: 'Manual', email: `manual-${stamp()}@e2e.local` });
    await db.platformLead.update({
      where: { id: manual.id },
      data: {
        createdAt: new Date(Date.now() - 40 * DAY),
        firstResponseAt: new Date(Date.now() - 2 * DAY),
      },
    });
    const mid = await stats();
    expect(mid.direct.leads).toBe(before.direct.leads + 1);
    for (const stage of ['contacted', 'interested', 'trial', 'customer'] as const) {
      expect(mid.funnel.find((f) => f.stage === stage)!.reached).toBe(
        before.funnel.find((f) => f.stage === stage)!.reached,
      );
    }
    expect(mid.funnel.find((f) => f.stage === 'new')!.reached).toBe(
      before.funnel.find((f) => f.stage === 'new')!.reached + 1,
    );
    // La mediana se calcula solo con quien escribió solo.
    const from = new Date(mid.from);
    const inbound = await db.platformLead.findMany({
      where: {
        discardedAt: null,
        createdAt: { gte: from },
        createdById: null,
        firstResponseAt: { not: null },
        source: { in: ['web_contact', 'demo', 'calculator'] },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    const hours = inbound
      .map((l) => Math.max(0, (l.firstResponseAt!.getTime() - l.createdAt.getTime()) / HOUR))
      .sort((a, b) => a - b);
    const median = hours.length
      ? hours.length % 2
        ? hours[(hours.length - 1) / 2]!
        : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2
      : null;
    expect(mid.medianFirstResponseHours).toBe(
      median === null ? null : Math.round(median * 10) / 10,
    );
    // El periodo empieza el día 1 de un mes en hora de España.
    const fromDay = from.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    expect(fromDay.endsWith('-01')).toBe(true);
    expect(from.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })).toBe('0:00:00');

    // Paga: lo que suma es su cuota sin IVA (la misma de Métricas).
    await db.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'active' } });
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 79,
        currency: 'EUR',
        paidAt: new Date(),
      },
    });
    await leads.syncFromTenants();
    const expected = (await currentMrrByTenant(app.get(PrismaAdminService))).get(tenantId)!.total;
    const after = await stats();
    expect(Math.round((after.mrr - mid.mrr) * 100) / 100).toBe(expected);
    expect(after.direct.customers).toBe(mid.direct.customers + 1);
  });

  it('el tablero avisa cuando hay más leads abiertos de los que caben', async () => {
    const s = stamp();
    await db.platformLead.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        status: 'new',
        source: 'admin',
        companyName: `Tablero ${s} ${i}`,
        email: `tablero-${i}-${s}@e2e.local`,
      })),
    });
    try {
      const board = await http().get('/admin/leads').set(auth()).expect(200);
      const openTotal =
        board.body.counts.new +
        board.body.counts.contacted +
        board.body.counts.interested +
        board.body.counts.trial;
      expect(board.body.truncated).toBe(true);
      expect(board.body.hiddenOpen).toBe(openTotal - 500);
      const search = await http()
        .get(`/admin/leads?search=${encodeURIComponent(`Tablero ${s} 7`)}`)
        .set(auth())
        .expect(200);
      expect(search.body.truncated).toBe(false);
      expect(search.body.hiddenOpen).toBe(0);
    } finally {
      await db.platformLead.deleteMany({ where: { email: { endsWith: `-${s}@e2e.local` } } });
    }
  });

  it('descartados: se ven en su lista, en solo lectura, y se recuperan', async () => {
    const s = stamp();
    const lead = await newLead({ companyName: `Descarte ${s}`, email: `descarte-${s}@e2e.local` });
    await http().post(`/admin/leads/${lead.id}/discard`).set(auth()).expect(204);
    const read = await detail(lead.id);
    expect(read.discardedAt).toBeTruthy();
    // Solo lectura: no se trabaja.
    await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set(auth())
      .send({ status: 'contacted' })
      .expect(404);
    const board = await http()
      .get(`/admin/leads?search=${encodeURIComponent(`Descarte ${s}`)}`)
      .set(auth())
      .expect(200);
    expect(board.body.items).toHaveLength(0);
    const discarded = await http()
      .get(`/admin/leads?discarded=1&search=${encodeURIComponent(`Descarte ${s}`)}`)
      .set(auth())
      .expect(200);
    expect(discarded.body.items.map((l: { id: string }) => l.id)).toEqual([lead.id]);

    const restored = await http().post(`/admin/leads/${lead.id}/restore`).set(auth()).expect(200);
    expect(restored.body.discardedAt).toBeNull();
    const back = await http()
      .get(`/admin/leads?search=${encodeURIComponent(`Descarte ${s}`)}`)
      .set(auth())
      .expect(200);
    expect(back.body.items.map((l: { id: string }) => l.id)).toEqual([lead.id]);
    const audit = await db.superAdminAuditLog.findFirst({
      where: { targetId: lead.id, action: 'admin.platform_lead.restored' },
    });
    expect(audit?.superAdminId).toBe(superId);
  });

  it('perder un lead cierra sus seguimientos y todo queda en el registro de acciones', async () => {
    const s = stamp();
    const lead = await newLead({ contactName: 'Registro', email: `registro-${s}@e2e.local` });
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ city: 'Bilbao', phone: '+34 600 000 001' })
      .expect(200);
    await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set(auth())
      .send({ status: 'interested' })
      .expect(200);
    const f1 = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Enviar demo', dueDate: madridDay(2) })
      .expect(201);
    const followupId = f1.body.followups[0].id as string;
    await http()
      .patch(`/admin/leads/followups/${followupId}`)
      .set(auth())
      .send({ dueDate: madridDay(3) })
      .expect(200);
    const note = await http()
      .post(`/admin/leads/${lead.id}/activities`)
      .set(auth())
      .send({ type: 'note', content: 'Nota que se borra' })
      .expect(201);
    const noteId = note.body.activities.find((a: { type: string }) => a.type === 'note').id;
    await http().delete(`/admin/leads/${lead.id}/activities/${noteId}`).set(auth()).expect(200);
    await http()
      .post(`/admin/leads/${lead.id}/email`)
      .set(auth())
      .send({ subject: 'Hola de nuevo', body: 'Te escribo por la demo.' })
      .expect(200);

    const lost = await http()
      .post(`/admin/leads/${lead.id}/lose`)
      .set(auth())
      .send({ reasonCode: 'price', recontactOn: madridDay(30) })
      .expect(200);
    const followups = lost.body.followups as { id: string; title: string; status: string }[];
    expect(followups.find((f) => f.id === followupId)?.status).toBe('done');
    expect(followups.find((f) => f.title === 'Volver a contactar')?.status).toBe('pending');
    await http().post(`/admin/leads/${lead.id}/reopen`).set(auth()).expect(200);
    await http().delete(`/admin/leads/followups/${followupId}`).set(auth()).expect(204);

    const logs = await db.superAdminAuditLog.findMany({
      where: { targetId: lead.id, superAdminId: superId },
      select: { action: true, changes: true },
    });
    const actions = logs.map((l) => l.action);
    for (const action of [
      'created',
      'updated',
      'moved',
      'followup_created',
      'followup_updated',
      'activity_deleted',
      'email_sent',
      'lost',
      'reopened',
      'followup_deleted',
    ]) {
      expect(actions).toContain(`admin.platform_lead.${action}`);
    }
    const updated = logs.find((l) => l.action === 'admin.platform_lead.updated')!;
    expect(updated.changes).toEqual({ fields: ['phone', 'city'] });
    expect(JSON.stringify(updated.changes)).not.toContain('Bilbao');
  });

  it('una propuesta cuyo correo no sale no se queda creada', async () => {
    const s = stamp();
    const email = `bloqueado-${s}@e2e.local`;
    const lead = await newLead({ companyName: `Propuesta ${s}`, email });
    await db.emailSuppression.create({
      data: { email, scope: 'all', reason: 'hard_bounce', provider: 'test' },
    });
    try {
      const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
      const res = await http()
        .post(`/admin/leads/${lead.id}/quote`)
        .set(auth())
        .send({ planId: plan.id, cycle: 'monthly', addons: [], followupDays: 3 })
        .expect(400);
      expect(res.body.code).toBe('email_suppressed');
      expect(await db.platformQuoteOffer.count({ where: { leadId: lead.id } })).toBe(0);
      const after = await detail(lead.id);
      expect(after.status).toBe('new');
      expect(after.followups).toHaveLength(0);
      expect(
        await db.superAdminAuditLog.count({
          where: { targetId: lead.id, action: 'admin.platform_lead.quote_sent' },
        }),
      ).toBe(0);
    } finally {
      await db.emailSuppression.deleteMany({ where: { email } });
    }
  });
});
