import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SalesPortfoliosService } from '../src/modules/admin/sales/sales-portfolios.service';

import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  SalesPortfolioDetailDto,
  SalesPortfolioListDto,
  SalesPortfolioRowDto,
} from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `pfv-super-${STAMP}@storageos.local`,
  support: `pfv-support-${STAMP}@storageos.local`,
  repA: `pfv-a-${STAMP}@storageos.local`,
  repB: `pfv-b-${STAMP}@storageos.local`,
};
const DAY = 86_400_000;

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: PASSWORD });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

describe('Comerciales: carteras para la dirección (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const tokens = {} as Record<keyof typeof EMAILS, string>;
  const ids = {} as Record<keyof typeof EMAILS, string>;
  let alertDaysBefore = 5;
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = Date.now();

  const lead = (name: string, over: Record<string, unknown> = {}) =>
    db.platformLead.create({
      data: {
        status: 'contacted',
        source: 'admin',
        companyName: `${name} ${STAMP}`,
        email: `${name.toLowerCase().replace(/\s+/g, '-')}-${STAMP}@e2e.local`,
        salesRepId: ids.repA,
        salesAssignedAt: new Date(now - 5 * DAY),
        salesSeenAt: new Date(now - 4 * DAY),
        ...over,
      },
    });

  const list = async (query: Record<string, string> = {}) => {
    const res = await http()
      .get('/admin/sales-team/portfolios')
      .query({ search: STAMP, limit: '100', ...query })
      .set(auth(tokens.super));
    expect(res.status).toBe(200);
    return res.body as SalesPortfolioListDto;
  };
  const names = (rows: SalesPortfolioRowDto[]) =>
    rows.map((r) => r.displayName.replace(` ${STAMP}`, ''));

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    for (const [key, name, role] of [
      ['super', 'Dirección Carteras', 'superadmin'],
      ['support', 'Soporte Carteras', 'support'],
      ['repA', 'Ana Cartera', 'sales'],
      ['repB', 'Beto Cartera', 'sales'],
    ] as const) {
      const row = await db.superAdmin.create({
        data: { email: EMAILS[key], passwordHash, fullName: name, role },
      });
      ids[key] = row.id;
    }
    const settings = await db.platformSalesSettings.findFirst();
    alertDaysBefore = settings?.firstContactAlertDays ?? 5;
    app = await createTestApp();
    for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
      tokens[key] = await login(app, EMAILS[key]);
    }
    await db.superAdmin.updateMany({
      where: { id: { in: [ids.repA, ids.repB] } },
      data: { twoFactorEnabled: true },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.platformSalesSettings.updateMany({
      data: { firstContactAlertDays: alertDaysBefore },
    });
    await db.platformLead.deleteMany({ where: { companyName: { contains: STAMP } } });
    await db.superAdminNotification.deleteMany({
      where: {
        OR: [
          { body: { contains: STAMP } },
          { title: { contains: STAMP } },
          { recipientId: { in: [ids.repA, ids.repB] } },
        ],
      },
    });
    await db.superAdminAuditLog.deleteMany({
      where: { superAdminId: { in: Object.values(ids) } },
    });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await cleanupTestTenants();
    await db.$disconnect();
  });

  it('la tabla junta las carteras de todos, con filtros, embudo y orden', async () => {
    const contacted = await lead('Alfa Contactado', {
      status: 'interested',
      salesBatch: `Feria ${STAMP}`,
    });
    await db.salesAccountProfile.create({
      data: {
        leadId: contacted.id,
        temperature: 'hot',
        nextAction: 'Mandar propuesta',
        lastContactAt: new Date(now - 2 * DAY),
      },
    });
    await lead('Beta Nunca', { status: 'new', salesAssignedAt: new Date(now - 20 * DAY) });
    await lead('Gamma De Beto', { salesRepId: ids.repB, salesAssignedAt: new Date(now - 9 * DAY) });
    await lead('Delta Archivado', {
      status: 'lost',
      lostAt: new Date(now - DAY),
      lostReasonCode: 'not_now',
      salesArchivedAt: new Date(now - DAY),
      salesRecoverOn: new Date(now + 90 * DAY),
    });
    await lead('Epsilon Libre', { salesRepId: null, salesAssignedAt: null });

    const all = await list();
    expect(names(all.items).sort()).toEqual(['Alfa Contactado', 'Beta Nunca', 'Gamma De Beto']);
    expect(all.total).toBe(3);
    // Sin tocar: el que nadie ha llamado en 20 días, primero.
    expect(names(all.items)[0]).toBe('Beta Nunca');
    const beta = all.items.find((r) => r.displayName.startsWith('Beta'))!;
    expect(beta.neverContacted).toBe(true);
    expect(beta.daysUntouched).toBeGreaterThanOrEqual(19);
    expect(beta.salesRepName).toBe('Ana Cartera');
    const alfa = all.items.find((r) => r.displayName.startsWith('Alfa'))!;
    expect(alfa.neverContacted).toBe(false);
    expect(alfa.daysUntouched).toBe(2);
    expect(alfa.salesProfile?.temperature).toBe('hot');
    expect(alfa.salesProfile?.nextAction).toBe('Mandar propuesta');
    expect(alfa.salesBatch).toBe(`Feria ${STAMP}`);
    expect(all.funnel.new).toBe(1);
    expect(all.funnel.interested).toBe(1);
    expect(all.funnel.contacted).toBe(1);
    expect(all.archived).toBe(1);
    expect(all.untouched).toBe(2);
    expect(all.reps.some((r) => r.id === ids.repA)).toBe(true);

    expect(names((await list({ rep: ids.repB })).items)).toEqual(['Gamma De Beto']);
    expect(names((await list({ rep: 'none' })).items)).toEqual(['Epsilon Libre']);
    expect(names((await list({ status: 'interested' })).items)).toEqual(['Alfa Contactado']);
    expect(names((await list({ temperature: 'hot' })).items)).toEqual(['Alfa Contactado']);
    expect(names((await list({ batch: `feria ${STAMP}` })).items)).toEqual(['Alfa Contactado']);
    expect(names((await list({ scope: 'archived' })).items)).toEqual(['Delta Archivado']);
    expect(names((await list({ untouchedDays: '10' })).items)).toEqual(['Beta Nunca']);
    expect(names((await list({ neverContacted: 'true' })).items).sort()).toEqual([
      'Beta Nunca',
      'Gamma De Beto',
    ]);
    const byRep = await list({ sort: 'rep', dir: 'desc' });
    expect(names(byRep.items)[0]).toBe('Gamma De Beto');

    // Por páginas y el CSV con todas.
    const page1 = await list({ limit: '2' });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list({ limit: '2', cursor: page1.nextCursor! });
    expect(names(page2.items)).toHaveLength(1);
    const csv = await http()
      .get('/admin/sales-team/portfolios/export')
      .query({ search: STAMP })
      .set(auth(tokens.super));
    expect(csv.status).toBe(200);
    expect(csv.body).toHaveLength(3);

    const bad = await http()
      .get('/admin/sales-team/portfolios')
      .query({ rep: 'nadie' })
      .set(auth(tokens.super));
    expect(bad.status).toBe(400);
  });

  it('soporte y los comerciales no la ven', async () => {
    for (const t of [tokens.support, tokens.repA]) {
      const res = await http().get('/admin/sales-team/portfolios').set(auth(t));
      expect(res.status).toBe(403);
    }
    const l = await lead('Zeta Prohibido');
    const res = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/notes`)
      .send({ content: 'No debería entrar' })
      .set(auth(tokens.support));
    expect(res.status).toBe(403);
  });

  it('la ficha trae la ficha comercial y toda la cronología', async () => {
    const l = await lead('Eta Ficha');
    await db.salesAccountProfile.create({
      data: { leadId: l.id, pinnedNote: 'Tiene 3 locales', decisionMaker: 'La socia' },
    });
    await db.salesAssignment.create({
      data: {
        repId: ids.repA,
        leadId: l.id,
        source: 'direction',
        assignedById: ids.super,
        startedAt: new Date(now - 5 * DAY),
      },
    });
    await db.platformLeadActivity.create({
      data: {
        leadId: l.id,
        superAdminId: ids.repA,
        type: 'call',
        content: 'No contesta',
        occurredAt: new Date(now - 3 * DAY),
      },
    });
    await db.platformLeadFollowup.create({
      data: {
        leadId: l.id,
        superAdminId: ids.repA,
        assignedToId: ids.repA,
        title: 'Volver a llamar',
        dueDate: new Date(now + DAY),
      },
    });
    await db.salesAppointment.create({
      data: {
        leadId: l.id,
        repId: ids.repA,
        kind: 'video',
        title: 'Demo',
        startsAt: new Date(now + 2 * DAY),
      },
    });
    const res = await http().get(`/admin/sales-team/portfolios/${l.id}`).set(auth(tokens.super));
    expect(res.status).toBe(200);
    const d = res.body as SalesPortfolioDetailDto;
    expect(d.rep?.id).toBe(ids.repA);
    expect(d.assignedSource).toBe('direction');
    expect(d.account.profile?.pinnedNote).toBe('Tiene 3 locales');
    expect(d.account.profile?.decisionMaker).toBe('La socia');
    expect(d.neverContacted).toBe(false);
    const kinds = new Set(d.timeline.map((e) => e.kind));
    for (const k of ['activity', 'followup', 'appointment', 'assignment']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    const reparto = d.timeline.find((e) => e.kind === 'assignment')!;
    expect(reparto.byDirection).toBe(true);
    expect(reparto.title).toContain('Ana Cartera');
    // De lo último a lo primero.
    const times = d.timeline.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);

    const missing = await http()
      .get('/admin/sales-team/portfolios/00000000-0000-0000-0000-000000000000')
      .set(auth(tokens.super));
    expect(missing.status).toBe(404);
  });

  it('una nota de la dirección avisa al comercial y no cuenta como contacto', async () => {
    const l = await lead('Theta Nota', { status: 'new' });
    const res = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/notes`)
      .send({ content: `Llámale antes del viernes ${STAMP}` })
      .set(auth(tokens.super));
    expect(res.status).toBe(201);
    const d = res.body as SalesPortfolioDetailDto;
    const note = d.timeline.find((e) => e.activityType === 'direction');
    expect(note?.byDirection).toBe(true);
    expect(note?.detail).toContain('Llámale antes del viernes');
    expect(note?.author).toBe('Dirección Carteras');
    expect(d.neverContacted).toBe(true);
    expect(d.lastContactAt).toBeNull();

    const notice = await db.superAdminNotification.findFirst({
      where: { recipientId: ids.repA, type: 'sales.direction', body: { contains: STAMP } },
    });
    expect(notice?.link).toBe(`/admin/sales/accounts/${l.id}`);

    // Para el comercial sigue «sin tocar» y sin actividad.
    const mine = await http()
      .get('/admin/sales/leads')
      .query({ filter: 'untouched', search: 'Theta Nota' })
      .set(auth(tokens.repA));
    expect(mine.status).toBe(200);
    const row = mine.body.items.find((i: { id: string }) => i.id === l.id);
    expect(row).toBeDefined();
    expect(row.lastActivityAt).toBeNull();
    const table = await list({ neverContacted: 'true' });
    expect(table.items.some((r) => r.id === l.id)).toBe(true);

    const audit = await db.superAdminAuditLog.findFirst({
      where: { superAdminId: ids.super, action: 'admin.sales.direction_note' },
    });
    expect(audit).not.toBeNull();
  });

  it('reasigna a otro comercial (o lo deja sin comercial)', async () => {
    const l = await lead('Iota Reparto');
    const res = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/reassign`)
      .send({ repId: ids.repB })
      .set(auth(tokens.super));
    expect(res.status).toBe(200);
    const d = res.body as SalesPortfolioDetailDto;
    expect(d.rep?.id).toBe(ids.repB);
    expect(d.assignedSource).toBe('manual');
    expect(d.timeline.some((e) => e.byDirection && e.detail?.includes('Beto Cartera'))).toBe(true);
    const toB = await db.superAdminNotification.findFirst({
      where: { recipientId: ids.repB, type: 'sales.assigned', title: { contains: STAMP } },
    });
    expect(toB).not.toBeNull();
    const toA = await db.superAdminNotification.findFirst({
      where: { recipientId: ids.repA, type: 'sales.unassigned', title: { contains: STAMP } },
    });
    expect(toA).not.toBeNull();

    const same = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/reassign`)
      .send({ repId: ids.repB })
      .set(auth(tokens.super));
    expect(same.status).toBe(400);

    const none = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/reassign`)
      .send({ repId: null })
      .set(auth(tokens.super));
    expect(none.status).toBe(200);
    expect((none.body as SalesPortfolioDetailDto).rep).toBeNull();
    const audit = await db.superAdminAuditLog.findMany({
      where: { superAdminId: ids.super, action: 'admin.sales.direction_reassigned' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('edita la ficha comercial y mueve de fase, constando que lo hizo la dirección', async () => {
    const l = await lead('Kappa Ficha', { status: 'new' });
    const profile = await http()
      .patch(`/admin/sales-team/portfolios/${l.id}/profile`)
      .send({ temperature: 'warm', nextAction: 'Visitarle el martes' })
      .set(auth(tokens.super));
    expect(profile.status).toBe(200);
    let d = profile.body as SalesPortfolioDetailDto;
    expect(d.account.profile?.temperature).toBe('warm');
    expect(d.account.profile?.nextAction).toBe('Visitarle el martes');
    expect(d.account.profile?.lastContactAt).toBeNull();
    expect(d.neverContacted).toBe(true);
    const edit = d.timeline.find((e) => e.byDirection && e.detail?.includes('Ficha comercial'));
    expect(edit?.detail).toContain('Templado');

    const moved = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/move`)
      .send({ status: 'interested' })
      .set(auth(tokens.super));
    expect(moved.status).toBe(200);
    d = moved.body as SalesPortfolioDetailDto;
    expect(d.account.lead.status).toBe('interested');
    expect(d.timeline.some((e) => e.byDirection && e.detail?.includes('Interesado'))).toBe(true);
    // Lo que anota el sistema por el cambio queda como de la dirección.
    const system = await db.platformLeadActivity.count({
      where: { leadId: l.id, superAdminId: ids.super, type: 'system' },
    });
    expect(system).toBe(0);
    expect(d.neverContacted).toBe(true);

    for (const action of ['admin.sales.direction_profile_updated', 'admin.sales.direction_moved']) {
      const row = await db.superAdminAuditLog.findFirst({
        where: { superAdminId: ids.super, action },
      });
      expect((row?.changes as { byDirection?: boolean } | null)?.byDirection).toBe(true);
    }
    const toRep = await db.superAdminNotification.count({
      where: { recipientId: ids.repA, type: 'sales.direction', title: { contains: STAMP } },
    });
    expect(toRep).toBeGreaterThanOrEqual(2);
  });

  it('archiva y recupera desde Carteras', async () => {
    const l = await lead('Lambda Archivo');
    const archived = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/archive`)
      .send({ reasonCode: 'price' })
      .set(auth(tokens.super));
    expect(archived.status).toBe(200);
    let d = archived.body as SalesPortfolioDetailDto;
    expect(d.account.lead.status).toBe('lost');
    expect(d.account.lead.salesArchivedAt).not.toBeNull();
    expect(d.rep?.id).toBe(ids.repA);
    expect((await list({ scope: 'archived' })).items.some((r) => r.id === l.id)).toBe(true);

    const recovered = await http()
      .post(`/admin/sales-team/portfolios/${l.id}/recover`)
      .set(auth(tokens.super));
    expect(recovered.status).toBe(200);
    d = recovered.body as SalesPortfolioDetailDto;
    expect(d.account.lead.status).not.toBe('lost');
    expect(d.account.lead.salesArchivedAt).toBeNull();
    expect(d.timeline.filter((e) => e.byDirection).length).toBeGreaterThanOrEqual(2);
  });

  it('avisa a la dirección de lo repartido sin primer contacto (una vez)', async () => {
    const put = await http()
      .put('/admin/sales-team/settings')
      .send({ firstContactAlertDays: 5 })
      .set(auth(tokens.super));
    expect(put.status).toBe(200);
    expect(put.body.firstContactAlertDays).toBe(5);

    const assigned = new Date(now - 7 * DAY);
    const silent = await lead('Mu Sin Llamar', { status: 'new', salesAssignedAt: assigned });
    const called = await lead('Nu Llamado', { status: 'contacted', salesAssignedAt: assigned });
    const recent = await lead('Xi Reciente', {
      status: 'new',
      salesAssignedAt: new Date(now - 2 * DAY),
    });
    const own = await lead('Omicron Suyo', { status: 'new', salesAssignedAt: assigned });
    for (const [l, source, by] of [
      [silent, 'direction', ids.super],
      [called, 'direction', ids.super],
      [recent, 'direction', ids.super],
      [own, 'lead', ids.repA],
    ] as const) {
      await db.salesAssignment.create({
        data: {
          repId: ids.repA,
          leadId: l.id,
          source,
          assignedById: by,
          startedAt: l.salesAssignedAt!,
        },
      });
    }
    await db.platformLeadActivity.create({
      data: {
        leadId: called.id,
        superAdminId: ids.repA,
        type: 'call',
        content: 'Hablamos',
        occurredAt: new Date(now - 3 * DAY),
      },
    });
    // Una nota de la dirección no es primer contacto.
    await db.platformLeadActivity.create({
      data: {
        leadId: silent.id,
        superAdminId: ids.super,
        type: 'direction',
        subject: 'Nota de la dirección',
        content: 'Llámale',
      },
    });

    const since = new Date();
    const service = app.get(SalesPortfoliosService);
    expect(await service.warnFirstContact()).toBeGreaterThanOrEqual(1);
    const warned = await db.platformLead.findMany({
      where: { id: { in: [silent.id, called.id, recent.id, own.id] } },
      select: { id: true, salesFirstContactWarnedAt: true },
    });
    const warnedOf = new Map(warned.map((w) => [w.id, w.salesFirstContactWarnedAt]));
    expect(warnedOf.get(silent.id)).not.toBeNull();
    expect(warnedOf.get(called.id)).toBeNull();
    expect(warnedOf.get(recent.id)).toBeNull();
    expect(warnedOf.get(own.id)).toBeNull();
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'sales.first_contact_missing', recipientId: null, createdAt: { gte: since } },
    });
    expect(notice).not.toBeNull();

    // Una vez por prospecto: la segunda pasada no lo vuelve a avisar.
    const first = warnedOf.get(silent.id)!;
    await service.warnFirstContact();
    const again = await db.platformLead.findUnique({
      where: { id: silent.id },
      select: { salesFirstContactWarnedAt: true },
    });
    expect(again?.salesFirstContactWarnedAt?.getTime()).toBe(first.getTime());
  });
});
