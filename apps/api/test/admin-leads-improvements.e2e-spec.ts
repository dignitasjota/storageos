import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import { estimatePlatformLeadValue } from '@storageos/shared';
import request from 'supertest';

import { AdminQuoteService } from '../src/modules/admin/admin-quote.service';
import { PlatformLeadSequencesService } from '../src/modules/admin/leads/core/platform-lead-sequences.service';
import { PlatformLeadsService } from '../src/modules/admin/leads/platform-leads.service';

import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  ImportCommitDto,
  ImportPreviewDto,
  PlatformLeadDetailDto,
  PlatformLeadDuplicateDto,
  PlatformLeadListDto,
  PlatformLeadStatsDto,
} from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const INBOUND_SECRET = 'email-inbound-secret-e2e';
const INBOUND_DOMAIN = 'r.trasteros.test';
const EMAILS = {
  super: `leads-imp-super-${STAMP}@storageos.local`,
  superB: `leads-imp-superb-${STAMP}@storageos.local`,
  support: `leads-imp-support-${STAMP}@storageos.local`,
  rep: `leads-imp-rep-${STAMP}@storageos.local`,
};
const DAY = 86_400_000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Mejoras de los leads del panel admin: puntuación y cuota prevista,
 * conversación por correo (respuestas al hilo, plantillas y adjuntos),
 * seguimiento de la propuesta, secuencias automáticas, reparto por turnos y
 * reasignación, lista con filtros, vistas y lote, duplicados y fusión, motivo
 * de descarte, Resultados, importación, captura rápida, parados en «Hoy» y
 * permisos del rol soporte.
 */
describe('Mejoras de los leads del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let supportToken: string;
  let repToken: string;
  let superId: string;
  let superBId: string;
  let repId: string;
  let settingsBackup: Record<string, unknown> | null = null;
  const http = () => request(app.getHttpServer());
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function login(email: string): Promise<string> {
    const res = await http().post('/admin/auth/login').send({ email, password: PASSWORD });
    if (!res.body.accessToken) throw new Error(`login ${email}: ${JSON.stringify(res.body)}`);
    return res.body.accessToken as string;
  }

  async function detail(id: string, t = token): Promise<PlatformLeadDetailDto> {
    const res = await http().get(`/admin/leads/${id}`).set(auth(t)).expect(200);
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

  beforeAll(async () => {
    process.env.INBOUND_EMAIL_DOMAIN = INBOUND_DOMAIN;
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    // El comercial, sin la verificación en dos pasos obligatoria (para la prueba).
    const mk = (email: string, fullName: string, role: 'superadmin' | 'support' | 'sales') =>
      db.superAdmin.create({
        data: { email, passwordHash, fullName, role, salesTwoFactorExempt: role === 'sales' },
      });
    superId = (await mk(EMAILS.super, 'Dirección Mejoras', 'superadmin')).id;
    superBId = (await mk(EMAILS.superB, 'Bea Turno', 'superadmin')).id;
    await mk(EMAILS.support, 'Soporte Mejoras', 'support');
    repId = (await mk(EMAILS.rep, 'Rita Comercial', 'sales')).id;
    const s = await db.platformLeadSettings.findFirst();
    settingsBackup = s ? { ...s } : null;
    app = await createTestApp();
    token = await login(EMAILS.super);
    supportToken = await login(EMAILS.support);
    repToken = await login(EMAILS.rep);
  });

  afterAll(async () => {
    await app.close();
    // Los ajustes son de toda la plataforma: se dejan como estaban.
    const s = await db.platformLeadSettings.findFirst();
    if (s) {
      await db.platformLeadSettings.update({
        where: { id: s.id },
        data: settingsBackup
          ? {
              assignMode: settingsBackup.assignMode as string,
              roundRobinIds: settingsBackup.roundRobinIds as string[],
              zoneRules: settingsBackup.zoneRules as object,
              lastAssignedId: settingsBackup.lastAssignedId as string | null,
              responseHours: settingsBackup.responseHours as number,
              businessHours: settingsBackup.businessHours as boolean,
              reassignEnabled: settingsBackup.reassignEnabled as boolean,
              staleDays: settingsBackup.staleDays as object,
              highValueMonthly: settingsBackup.highValueMonthly as number,
              sequenceAutoStart: settingsBackup.sequenceAutoStart as boolean,
            }
          : {
              assignMode: 'off',
              roundRobinIds: [],
              zoneRules: [],
              lastAssignedId: null,
              highValueMonthly: 150,
            },
      });
    }
    const ids = [superId, superBId, repId];
    await db.platformLead.updateMany({
      where: { OR: [{ salesRepId: { in: ids } }, { assignedToId: { in: ids } }] },
      data: { salesRepId: null, assignedToId: null },
    });
    await db.platformLead.deleteMany({
      where: {
        OR: [
          { email: { contains: STAMP } },
          { companyName: { contains: STAMP } },
          { contactName: { contains: STAMP } },
        ],
      },
    });
    await db.salesAssignment.deleteMany({ where: { repId: { in: ids } } });
    await db.salesTemplate.deleteMany({ where: { name: { contains: STAMP } } });
    await db.platformLeadSequence.deleteMany({ where: { name: { contains: STAMP } } });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
    delete process.env.INBOUND_EMAIL_DOMAIN;
  });

  it('puntuación con sus motivos, cuota prevista y «€ en juego» por fase', async () => {
    const plan = await db.subscriptionPlan.findFirstOrThrow({
      where: { isActive: true, priceMonthly: { gt: 0 }, includedUnits: null },
      orderBy: { priceMonthly: 'desc' },
    });
    const lead = await newLead({
      companyName: `Puntos ${STAMP}`,
      email: `puntos-${STAMP}@e2e.local`,
      units: '150',
      facilities: '3',
      planSlug: plan.slug,
    });
    expect(lead.score).toBeGreaterThan(0);
    expect(lead.scoreFactors.map((f) => f.key)).toEqual(
      expect.arrayContaining(['units', 'facilities', 'source']),
    );
    const ctx = await app.get(PlatformLeadsService).insightContext();
    const expected = estimatePlatformLeadValue({ units: '150', planSlug: plan.slug }, ctx.value);
    expect(lead.estimatedMonthly).toBe(expected!.monthly);
    expect(lead.estimatedPlanName).toBe(plan.name);

    const board = await http()
      .get(`/admin/leads?search=${encodeURIComponent(`Puntos ${STAMP}`)}`)
      .set(auth())
      .expect(200);
    expect(board.body.valueByStage.new).toBe(expected!.monthly);
  });

  it('la conversación: dirección de respuesta propia, plantillas, adjuntos y respuesta al hilo', async () => {
    const email = `hilo-${STAMP}@e2e.local`;
    const lead = await newLead({ contactName: `Hilo ${STAMP}`, email, units: '40' });
    await db.salesTemplate.create({
      data: {
        name: `Primer contacto ${STAMP}`,
        channel: 'email',
        subject: 'Hola {nombre}',
        body: 'Sobre tus {trasteros} trasteros',
      },
    });
    const templates = await http()
      .get('/admin/leads/templates')
      .set(auth(supportToken))
      .expect(200);
    expect(
      templates.body.some((t: { name: string }) => t.name === `Primer contacto ${STAMP}`),
    ).toBe(true);

    const presign = await http()
      .post(`/admin/leads/${lead.id}/attachments/upload-url`)
      .set(auth())
      .send({ mimeType: 'image/png' })
      .expect(200);
    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    const sent = await http()
      .post(`/admin/leads/${lead.id}/email`)
      .set(auth())
      .send({
        subject: 'Tu plano',
        body: 'Te mando el plano',
        attachments: [{ key: presign.body.key, mimeType: 'image/png', filename: 'plano.png' }],
      })
      .expect(200);
    const out = (sent.body as PlatformLeadDetailDto).activities.find((a) => a.type === 'email_out');
    expect(out?.attachments).toHaveLength(1);
    // Un adjunto de otro lead no vale.
    await http()
      .post(`/admin/leads/${lead.id}/email`)
      .set(auth())
      .send({
        subject: 'Otro',
        body: 'Otro',
        attachments: [
          { key: 'platform/leads/otro/x.png', mimeType: 'image/png', filename: 'x.png' },
        ],
      })
      .expect(400);

    const mail = await waitForEmail(email, { subjectIncludes: 'Tu plano' });
    const replyTo = mail.ReplyTo?.[0]?.Address ?? '';
    expect(replyTo).toMatch(new RegExp(`^p-[a-f0-9]+@${INBOUND_DOMAIN}$`));
    expect(mail.Text).toContain('Adjuntos');
    // El primer correo pone en marcha la secuencia de por defecto.
    expect((await detail(lead.id)).sequence?.status).toBe('active');

    await http()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: email,
        to: [`TrasterOS <${replyTo}>`],
        subject: 'Re: Tu plano',
        text: 'Me interesa, llámame\n\nEl lun, a las 10:12, TrasterOS escribió:\n> Te mando el plano',
        dmarc: 'pass',
      })
      .expect(200);
    const after = await detail(lead.id);
    const reply = after.activities.find((a) => a.type === 'email_in');
    expect(reply?.content).toBe('Me interesa, llámame');
    expect(after.awaitingReplySince).not.toBeNull();
    // Ha contestado: los correos automáticos se paran solos.
    expect(after.sequence?.status).toBe('stopped');
    expect(after.sequence?.stopReason).toBe('replied');
    expect(after.scoreFactors.some((f) => f.key === 'replied')).toBe(true);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'platform_lead.email_reply', link: `/admin/leads?lead=${lead.id}` },
    });
    expect(notice?.recipientId).toBe(superId);
  });

  it('la propuesta: cuántas veces la abre y un solo aviso a quien lleva el lead', async () => {
    const lead = await newLead({
      contactName: `Propuesta ${STAMP}`,
      email: `prop-${STAMP}@e2e.local`,
    });
    await http()
      .patch(`/admin/leads/${lead.id}`)
      .set(auth())
      .send({ assignedToId: superBId })
      .expect(200);
    const plan = await db.subscriptionPlan.findFirstOrThrow({
      where: { isActive: true, priceMonthly: { gt: 0 }, includedUnits: null },
    });
    await http()
      .post(`/admin/leads/${lead.id}/quote`)
      .set(auth())
      .send({ planId: plan.id, cycle: 'monthly', addons: [], followupDays: 0 })
      .expect(200);
    const offer = await db.platformQuoteOffer.findFirstOrThrow({ where: { leadId: lead.id } });
    const url = new URL(app.get(AdminQuoteService).trackedUrl(offer.id));
    const path = url.pathname.replace(/^\/v1/, '') + url.search;
    await http().get(path).expect(302);
    await http().get(path).expect(302);
    const after = await detail(lead.id);
    expect(after.quoteOffers[0]?.openCount).toBe(2);
    expect(after.quoteOffers[0]?.lastOpenedAt).not.toBeNull();
    expect(after.proposalOpens).toBe(2);
    expect(after.scoreFactors.some((f) => f.key === 'proposal')).toBe(true);
    const notices = await db.superAdminNotification.findMany({
      where: { type: 'sales.offer_opened', link: `/admin/leads?lead=${lead.id}` },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.recipientId).toBe(superBId);
  });

  it('secuencia: manda el paso que toca, una sola vez, y se para al hablar con él', async () => {
    const email = `seq-${STAMP}@e2e.local`;
    const lead = await newLead({
      contactName: `Secuencia ${STAMP}`,
      companyName: `Seq ${STAMP}`,
      email,
    });
    const started = await http()
      .post(`/admin/leads/${lead.id}/sequence`)
      .set(auth())
      .send({ enabled: true })
      .expect(200);
    expect(started.body.sequence.status).toBe('active');
    // Otra vez: ya tiene una en marcha.
    await http()
      .post(`/admin/leads/${lead.id}/sequence`)
      .set(auth())
      .send({ enabled: true })
      .expect(409);

    const sequences = app.get(PlatformLeadSequencesService);
    await db.platformLeadSequenceEnrollment.updateMany({
      where: { leadId: lead.id, status: 'active' },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    await sequences.runDue();
    await sequences.runDue();
    const once = await detail(lead.id);
    expect(once.sequence?.sent).toBe(1);
    expect(
      once.activities.filter((a) => a.content.includes('(Automático: secuencia')),
    ).toHaveLength(1);
    await waitForEmail(email, { subjectIncludes: '¿Pudiste verlo?' });

    // Le llaman: se para y el siguiente paso ya no sale aunque toque.
    await db.platformLeadSequenceEnrollment.updateMany({
      where: { leadId: lead.id, status: 'active' },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    await http()
      .post(`/admin/leads/${lead.id}/activities`)
      .set(auth())
      .send({ type: 'call', content: 'Hablamos, le interesa' })
      .expect(201);
    await sequences.runDue();
    const stopped = await detail(lead.id);
    expect(stopped.sequence?.status).toBe('stopped');
    expect(stopped.sequence?.sent).toBe(1);

    // Desactivada para un lead: el primer correo no la pone en marcha.
    const quiet = await newLead({
      contactName: `Sin secuencia ${STAMP}`,
      email: `quiet-${STAMP}@e2e.local`,
    });
    await http()
      .post(`/admin/leads/${quiet.id}/sequence`)
      .set(auth())
      .send({ enabled: false })
      .expect(200);
    await http()
      .post(`/admin/leads/${quiet.id}/email`)
      .set(auth())
      .send({ subject: 'Hola de nuevo', body: 'Texto' })
      .expect(200);
    const q = await detail(quiet.id);
    expect(q.sequenceOptOut).toBe(true);
    expect(q.sequence).toBeNull();
  });

  it('reparto por turnos que respeta la cartera y reasignación por plazo (una vez)', async () => {
    await http()
      .patch('/admin/leads/settings')
      .set(auth(supportToken))
      .send({ assignMode: 'round_robin' })
      .expect(403);
    await http()
      .patch('/admin/leads/settings')
      .set(auth())
      .send({
        assignMode: 'round_robin',
        roundRobinIds: [repId, superBId],
        responseHours: 4,
        businessHours: false,
        reassignEnabled: true,
      })
      .expect(200);
    // El turno empieza desde el principio.
    const s = await db.platformLeadSettings.findFirstOrThrow();
    await db.platformLeadSettings.update({ where: { id: s.id }, data: { lastAssignedId: null } });

    const leads = app.get(PlatformLeadsService);
    const ingest = (n: number) =>
      leads.ingestContact({
        contactMessageId: `m-${n}-${STAMP}`,
        source: 'web_contact',
        name: `Turno ${n} ${STAMP}`,
        email: `turno-${n}-${STAMP}@e2e.local`,
        phone: null,
        company: null,
        units: null,
        profile: null,
        message: 'Quiero información',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
      });
    const first = await ingest(1);
    const second = await ingest(2);
    expect(await leads.autoAssign(first)).toBe(repId);
    expect(await leads.autoAssign(second)).toBe(superBId);
    // Ya tiene responsable: no se vuelve a repartir.
    expect(await leads.autoAssign(first)).toBeNull();
    const firstRow = await db.platformLead.findUniqueOrThrow({ where: { id: first } });
    expect(firstRow.salesRepId).toBe(repId);
    expect(firstRow.responseDueAt).not.toBeNull();

    await db.platformLead.update({
      where: { id: first },
      data: { responseDueAt: new Date(Date.now() - 60_000) },
    });
    await leads.reassignOverdue();
    const moved = await db.platformLead.findUniqueOrThrow({ where: { id: first } });
    expect(moved.assignedToId).toBe(superBId);
    expect(moved.reassignedAt).not.toBeNull();
    // La cartera sigue a quien lo lleva: ya no es del comercial.
    expect(moved.salesRepId).toBeNull();
    await db.platformLead.update({
      where: { id: first },
      data: { responseDueAt: new Date(Date.now() - 60_000) },
    });
    await leads.reassignOverdue();
    expect((await db.platformLead.findUniqueOrThrow({ where: { id: first } })).assignedToId).toBe(
      superBId,
    );
    const notices = await db.superAdminNotification.findMany({
      where: { link: `/admin/leads?lead=${first}`, type: 'platform_lead.reassigned' },
    });
    expect(notices.map((n) => n.recipientId)).toEqual([repId]);

    await http().patch('/admin/leads/settings').set(auth()).send({ assignMode: 'off' }).expect(200);
  });

  it('lista con filtros, orden y páginas, vistas guardadas y acciones en lote', async () => {
    const city = `Ciudad${STAMP}`;
    const a = await newLead({
      companyName: `Lista A ${STAMP}`,
      email: `la-${STAMP}@e2e.local`,
      units: '300',
      city,
    });
    const b = await newLead({
      companyName: `Lista B ${STAMP}`,
      email: `lb-${STAMP}@e2e.local`,
      units: '20',
      city,
    });
    const c = await newLead({
      companyName: `Lista C ${STAMP}`,
      email: `lc-${STAMP}@e2e.local`,
      city,
    });

    const all = await http()
      .get(`/admin/leads/list?city=${city}&sort=score&dir=desc&limit=2`)
      .set(auth(supportToken))
      .expect(200);
    const page = all.body as PlatformLeadListDto;
    expect(page.total).toBe(3);
    expect(page.items[0]?.id).toBe(a.id);
    expect(page.nextCursor).toBe('2');
    const next = await http()
      .get(`/admin/leads/list?city=${city}&sort=score&dir=desc&limit=2&cursor=2`)
      .set(auth())
      .expect(200);
    expect((next.body as PlatformLeadListDto).items).toHaveLength(1);
    const big = await http()
      .get(`/admin/leads/list?city=${city}&sizeMin=200`)
      .set(auth())
      .expect(200);
    expect((big.body as PlatformLeadListDto).items.map((l) => l.id)).toEqual([a.id]);
    await http().get('/admin/leads/list?sort=nada').set(auth()).expect(400);

    const view = await http()
      .post('/admin/saved-views')
      .set(auth())
      .send({
        page: 'leads',
        name: `Grandes ${STAMP}`,
        filters: { filters: { city }, sort: 'score' },
      })
      .expect(201);
    const views = await http().get('/admin/saved-views?page=leads').set(auth()).expect(200);
    expect(views.body.some((v: { id: string }) => v.id === view.body.id)).toBe(true);
    await http().delete(`/admin/saved-views/${view.body.id}`).set(auth()).expect(204);

    const ids = [a.id, b.id, c.id];
    const assigned = await http()
      .post('/admin/leads/bulk')
      .set(auth(supportToken))
      .send({ action: 'assign', ids, assignedToId: superBId })
      .expect(200);
    expect(assigned.body).toEqual({ done: 3, failed: [] });
    await http()
      .post('/admin/leads/bulk')
      .set(auth())
      .send({ action: 'move', ids, status: 'interested' })
      .expect(200);
    const tomorrow = new Date(Date.now() + DAY).toLocaleDateString('sv-SE', {
      timeZone: 'Europe/Madrid',
    });
    await http()
      .post('/admin/leads/bulk')
      .set(auth())
      .send({ action: 'followup', ids: [a.id], title: 'Llamar', dueDate: tomorrow })
      .expect(200);
    const lost = await http()
      .post('/admin/leads/bulk')
      .set(auth())
      .send({
        action: 'lose',
        ids: [b.id, '00000000-0000-4000-8000-000000000000'],
        reasonCode: 'price',
      })
      .expect(200);
    expect(lost.body.done).toBe(1);
    expect(lost.body.failed).toHaveLength(1);
    await http().post('/admin/leads/bulk').set(auth()).send({ action: 'nada', ids }).expect(400);

    const da = await detail(a.id);
    expect(da.status).toBe('interested');
    expect(da.assignedToId).toBe(superBId);
    expect(da.nextFollowup?.title).toBe('Llamar');
    expect((await detail(b.id)).status).toBe('lost');

    const csv = await http()
      .get(`/admin/leads/export.csv?ids=${a.id},${c.id}`)
      .set(auth())
      .expect(200);
    expect(csv.text).toContain(`Lista A ${STAMP}`);
    expect(csv.text).toContain(`Lista C ${STAMP}`);
    expect(csv.text).not.toContain(`Lista B ${STAMP}`);
    expect(csv.text).toContain('Puntuación');
  });

  it('duplicados contra leads y cuentas, y fusión (auditada)', async () => {
    const target = await newLead({
      companyName: `Trasteros Pérez ${STAMP} S.L.`,
      email: `fus-a-${STAMP}@e2e.local`,
    });
    const source = await newLead({
      companyName: `trasteros perez ${STAMP}`,
      phone: `6${String(Date.now()).slice(-8)}`,
      city: 'Valencia',
    });
    await http()
      .post(`/admin/leads/${source.id}/activities`)
      .set(auth())
      .send({ type: 'note', content: 'Nota del duplicado' })
      .expect(201);
    const dup = (await detail(target.id)).duplicates.find((d) => d.id === source.id);
    expect(dup).toMatchObject({ kind: 'lead', reason: 'Empresa parecida', exact: false });

    // Contra cuentas: el email de un usuario y el NIF del negocio.
    const tenant = await db.tenant.findFirstOrThrow({
      where: { deletedAt: null, users: { some: {} } },
      select: { id: true, users: { select: { email: true }, take: 1 } },
    });
    const owner = tenant.users[0]!.email;
    const byEmail = await http()
      .post('/admin/leads/duplicates')
      .set(auth())
      .send({ email: owner })
      .expect(200);
    expect(
      (byEmail.body as PlatformLeadDuplicateDto[]).some(
        (d) => d.kind === 'tenant' && d.id === tenant.id,
      ),
    ).toBe(true);
    const nif = `B${String(Date.now()).slice(-7)}4`;
    const taxTenant = await db.tenant.findFirstOrThrow({
      where: { deletedAt: null },
      select: { id: true, taxId: true },
    });
    await db.tenant.update({ where: { id: taxTenant.id }, data: { taxId: nif } });
    try {
      const byNif = await http()
        .post('/admin/leads/duplicates')
        .set(auth())
        .send({ companyName: `Almacenes ${nif}` })
        .expect(200);
      expect(
        (byNif.body as PlatformLeadDuplicateDto[]).find((d) => d.id === taxTenant.id)?.reason,
      ).toContain('NIF');
    } finally {
      await db.tenant.update({ where: { id: taxTenant.id }, data: { taxId: taxTenant.taxId } });
    }

    await http()
      .post(`/admin/leads/${target.id}/merge`)
      .set(auth())
      .send({ sourceId: target.id })
      .expect(400);
    const merged = await http()
      .post(`/admin/leads/${target.id}/merge`)
      .set(auth())
      .send({ sourceId: source.id })
      .expect(200);
    const m = merged.body as PlatformLeadDetailDto;
    expect(m.phone).toBe(source.phone);
    expect(m.city).toBe('Valencia');
    expect(m.activities.some((a) => a.content === 'Nota del duplicado')).toBe(true);
    const gone = await detail(source.id);
    expect(gone.discardReasonCode).toBe('merged');
    expect(gone.mergedIntoId).toBe(target.id);
    await http().post(`/admin/leads/${source.id}/restore`).set(auth()).expect(409);
    const audit = await db.superAdminAuditLog.findFirst({
      where: { action: 'admin.platform_lead.merged', targetId: target.id },
    });
    expect(audit).not.toBeNull();
  });

  it('motivo de descarte: en la ficha, en descartados y en Resultados (con su comparación)', async () => {
    const spam = await newLead({ contactName: `Spam ${STAMP}`, email: `spam-${STAMP}@e2e.local` });
    await http()
      .post(`/admin/leads/${spam.id}/discard`)
      .set(auth())
      .send({ reasonCode: 'spam', reason: 'Venden enlaces' })
      .expect(204);
    const plain = await newLead({
      contactName: `Sin motivo ${STAMP}`,
      email: `plain-${STAMP}@e2e.local`,
    });
    await http().post(`/admin/leads/${plain.id}/discard`).set(auth()).expect(204);
    // «Fusionado» lo pone el sistema: no se elige a mano.
    await http()
      .post(`/admin/leads/${spam.id}/discard`)
      .set(auth())
      .send({ reasonCode: 'merged' })
      .expect(400);
    expect((await detail(spam.id)).discardReasonCode).toBe('spam');
    expect((await detail(plain.id)).discardReasonCode).toBe('other');
    const discarded = await http()
      .get(`/admin/leads?discarded=1&search=${encodeURIComponent(`Spam ${STAMP}`)}`)
      .set(auth())
      .expect(200);
    expect(discarded.body.items[0].discardReason).toBe('Venden enlaces');

    // Un lead del periodo anterior, con su campaña.
    const leads = app.get(PlatformLeadsService);
    const old = await leads.ingestContact({
      contactMessageId: `old-${STAMP}`,
      source: 'demo',
      name: `Antiguo ${STAMP}`,
      email: `old-${STAMP}@e2e.local`,
      phone: null,
      company: null,
      units: null,
      profile: null,
      message: 'Demo',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: `campana-${STAMP}`,
    });
    const now = await leads.ingestContact({
      contactMessageId: `now-${STAMP}`,
      source: 'demo',
      name: `Actual ${STAMP}`,
      email: `now-${STAMP}@e2e.local`,
      phone: null,
      company: null,
      units: null,
      profile: null,
      message: 'Demo',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: `campana-${STAMP}`,
    });
    await db.platformLead.update({
      where: { id: old },
      data: { createdAt: new Date(Date.now() - 95 * DAY) },
    });
    await http()
      .patch(`/admin/leads/${now}`)
      .set(auth())
      .send({ assignedToId: superId })
      .expect(200);

    const res = await http().get('/admin/leads/stats?months=3&source=demo').set(auth()).expect(200);
    const s = res.body as PlatformLeadStatsDto;
    expect(s.source).toBe('demo');
    expect(s.bySource.every((x) => x.source === 'demo')).toBe(true);
    expect(s.byCampaign.find((c) => c.key === `campana-${STAMP}`)?.leads).toBe(1);
    expect(s.byAssignee.some((x) => x.key === superId)).toBe(true);
    expect(s.previous.leads).toBeGreaterThanOrEqual(1);
    expect(s.stageDays.map((d) => d.stage)).toEqual(['new', 'contacted', 'interested', 'trial']);
    expect(s.valueByStage).toHaveLength(4);
    const all = await http().get('/admin/leads/stats?months=3').set(auth()).expect(200);
    const spamRow = (all.body as PlatformLeadStatsDto).discardReasons.find(
      (r) => r.code === 'spam',
    );
    expect(spamRow?.count).toBeGreaterThanOrEqual(1);
  });

  it('importar un CSV: vista previa con errores por fila y duplicados que se suman', async () => {
    const existing = await newLead({
      companyName: `Ya estaba ${STAMP}`,
      email: `ya-${STAMP}@e2e.local`,
    });
    const csv = [
      'Empresa,Persona,Email,Teléfono,Ciudad,Trasteros,Nota,Origen',
      `Nueva ${STAMP},Nora,nueva-${STAMP}@e2e.local,,Sevilla,80,De la feria,Feria o evento`,
      `Ya estaba ${STAMP},,ya-${STAMP}@e2e.local,,Bilbao,,Otra vez,`,
      `,,,,,,Sin datos,`,
      `Repetida ${STAMP},,nueva-${STAMP}@e2e.local,,,,,`,
      `Origen raro ${STAMP},,raro-${STAMP}@e2e.local,,,,,Marte`,
    ].join('\n');
    const body = { csv, source: 'event', onDuplicate: 'merge', assignedToId: superBId };
    const preview = await http()
      .post('/admin/leads/import/preview')
      .set(auth())
      .send(body)
      .expect(200);
    const p = preview.body as ImportPreviewDto;
    expect(p.summary).toEqual({ total: 5, valid: 1, invalid: 3, duplicates: 1 });
    expect(p.rows[3]?.errors[0]).toContain('Repetido');
    expect(p.rows[4]?.errors[0]).toContain('Marte');

    const commit = await http()
      .post('/admin/leads/import/commit')
      .set(auth(supportToken))
      .send(body)
      .expect(200);
    expect((commit.body as ImportCommitDto).summary).toEqual({ created: 2, skipped: 0, errors: 3 });
    const created = await db.platformLead.findFirstOrThrow({
      where: { email: `nueva-${STAMP}@e2e.local` },
    });
    expect(created).toMatchObject({
      source: 'event',
      city: 'Sevilla',
      units: '80',
      assignedToId: superBId,
    });
    const merged = await detail(existing.id);
    expect(merged.city).toBe('Bilbao');
    expect(merged.activities.some((a) => a.content.startsWith('Importado otra vez'))).toBe(true);
  });

  it('captura rápida con foto: del equipo y de un comercial (a su cartera)', async () => {
    const photo = await http()
      .post('/admin/leads/capture/photo-upload-url')
      .set(auth())
      .send({ mimeType: 'image/png' })
      .expect(200);
    await fetch(photo.body.uploadUrl as string, {
      method: 'PUT',
      headers: photo.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    const res = await http()
      .post('/admin/leads/capture')
      .set(auth())
      .send({
        contactName: `Feria ${STAMP}`,
        phone: `7${String(Date.now()).slice(-8)}`,
        note: 'Tiene 3 naves',
        photoKey: photo.body.key,
      })
      .expect(201);
    const lead = await detail(res.body.leadId as string);
    expect(lead.source).toBe('event');
    expect(lead.activities.some((a) => a.content === 'Tiene 3 naves')).toBe(true);
    expect(
      lead.activities.find((a) => a.content === 'Foto de su tarjeta')?.attachments,
    ).toHaveLength(1);
    // La foto de otro no vale.
    await http()
      .post('/admin/leads/capture')
      .set(auth())
      .send({
        contactName: `Foto ajena ${STAMP}`,
        phone: '600111222',
        photoKey: 'platform/leads/capture/otro/x.png',
      })
      .expect(400);

    const sales = await http()
      .post('/admin/leads/capture')
      .set(auth(repToken))
      .send({ companyName: `Prospecto ${STAMP}`, email: `prospecto-${STAMP}@e2e.local` })
      .expect(201);
    const row = await db.platformLead.findUniqueOrThrow({
      where: { id: sales.body.leadId as string },
    });
    expect(row.salesRepId).toBe(repId);
    // El resto del tablero sigue cerrado al comercial.
    await http().get('/admin/leads/list').set(auth(repToken)).expect(403);
  });

  it('leads parados: en «Hoy» (urgentes si son de alto valor) y un aviso por lead y fase', async () => {
    await http()
      .patch('/admin/leads/settings')
      .set(auth())
      .send({ highValueMonthly: 1, staleDays: { new: 1, contacted: 5, interested: 7, trial: 10 } })
      .expect(200);
    const plan = await db.subscriptionPlan.findFirstOrThrow({
      where: { isActive: true, priceMonthly: { gt: 0 }, includedUnits: null },
    });
    const lead = await newLead({
      companyName: `Parado ${STAMP}`,
      email: `parado-${STAMP}@e2e.local`,
      planSlug: plan.slug,
    });
    const long = new Date(Date.now() - 900 * DAY);
    await db.platformLead.update({
      where: { id: lead.id },
      data: { status: 'contacted', createdAt: long },
    });
    await db.platformLeadActivity.updateMany({
      where: { leadId: lead.id },
      data: { occurredAt: long },
    });

    const d = await detail(lead.id);
    expect(d.staleDays).toBeGreaterThanOrEqual(900);
    expect(d.highValue).toBe(true);
    const today = await http().get('/admin/today').set(auth()).expect(200);
    const row = today.body.staleLeads.find((l: { id: string }) => l.id === lead.id);
    expect(row).toMatchObject({ status: 'contacted', highValue: true });

    const leads = app.get(PlatformLeadsService);
    await leads.notifyStale();
    await leads.notifyStale();
    const notices = await db.superAdminNotification.findMany({
      where: { type: 'platform_lead.stale', link: `/admin/leads?lead=${lead.id}` },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.recipientId).toBe(superId);
    // En otra fase vuelve a avisar.
    await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set(auth())
      .send({ status: 'interested' })
      .expect(200);
    await db.platformLeadActivity.updateMany({
      where: { leadId: lead.id },
      data: { occurredAt: long },
    });
    await leads.notifyStale();
    expect(
      await db.superAdminNotification.count({
        where: { type: 'platform_lead.stale', link: `/admin/leads?lead=${lead.id}` },
      }),
    ).toBe(2);
  });

  it('soporte trabaja los leads pero no toca ajustes ni secuencias', async () => {
    await http().get('/admin/leads/settings').set(auth(supportToken)).expect(200);
    await http().get('/admin/leads/sequences').set(auth(supportToken)).expect(200);
    const body = {
      name: `Secuencia ${STAMP}`,
      steps: [{ day: 1, subject: 'Hola', body: 'Texto' }],
    };
    await http().post('/admin/leads/sequences').set(auth(supportToken)).send(body).expect(403);
    const created = await http().post('/admin/leads/sequences').set(auth()).send(body).expect(201);
    expect(created.body.isDefault).toBe(false);
    await http()
      .post('/admin/leads/sequences')
      .set(auth())
      .send({ name: `Mala ${STAMP}`, steps: [{ day: 1 }] })
      .expect(400);
    await http()
      .delete(`/admin/leads/sequences/${created.body.id}`)
      .set(auth(supportToken))
      .expect(403);
    await http().delete(`/admin/leads/sequences/${created.body.id}`).set(auth()).expect(204);
    const lead = await newLead({
      contactName: `Soporte ${STAMP}`,
      email: `sop-${STAMP}@e2e.local`,
    });
    await http().delete(`/admin/leads/${lead.id}`).set(auth(supportToken)).expect(403);
    await http()
      .post(`/admin/leads/${lead.id}/discard`)
      .set(auth(supportToken))
      .send({ reasonCode: 'support' })
      .expect(204);
  });
});
