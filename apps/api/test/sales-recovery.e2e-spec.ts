import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformLeadSequencesService } from '../src/modules/admin/leads/core/platform-lead-sequences.service';
import { PlatformLeadsService } from '../src/modules/admin/leads/platform-leads.service';
import { SalesAssignmentService } from '../src/modules/admin/sales/sales-assignment.service';
import { SalesCommissionsService } from '../src/modules/admin/sales/sales-commissions.service';
import { SalesRecoveryService } from '../src/modules/admin/sales/sales-recovery.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `rec-super-${STAMP}@storageos.local`,
  repA: `rec-a-${STAMP}@storageos.local`,
  repB: `rec-b-${STAMP}@storageos.local`,
};
const mail = (name: string) => `${name}-${STAMP}@e2e.local`;
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

/** Hoy (AAAA-MM-DD) en hora de España, sumando días. */
function madridDay(offset: number): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

/** Hoy más N meses (como la propuesta del servidor). */
function madridMonths(months: number): string {
  const [y, m, d] = madridDay(0).split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

describe('Comerciales: no interesados y recuperación (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const tokens = {} as Record<keyof typeof EMAILS, string>;
  const ids = {} as Record<keyof typeof EMAILS, string>;
  let releaseDaysBefore = 90;
  let recoverMonthsBefore: unknown = null;
  let cadenceId = '';
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = Date.now();

  const lead = (name: string, over: Record<string, unknown> = {}) =>
    db.platformLead.create({
      data: {
        status: 'contacted',
        source: 'admin',
        companyName: `${name} ${STAMP}`,
        email: mail(name.toLowerCase().replace(/\s+/g, '-')),
        salesRepId: ids.repA,
        salesAssignedAt: new Date(now - 5 * DAY),
        salesSeenAt: new Date(now - 4 * DAY),
        ...over,
      },
    });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    const sup = await db.superAdmin.create({
      data: { email: EMAILS.super, passwordHash, fullName: 'Dirección', role: 'superadmin' },
    });
    ids.super = sup.id;
    for (const [key, name] of [
      ['repA', 'Ana Recupera'],
      ['repB', 'Beto Recupera'],
    ] as const) {
      const rep = await db.superAdmin.create({
        data: { email: EMAILS[key], passwordHash, fullName: name, role: 'sales' },
      });
      ids[key] = rep.id;
    }
    const settings = await db.platformSalesSettings.findFirst();
    releaseDaysBefore = settings?.leadReleaseDays ?? 90;
    recoverMonthsBefore = settings?.recoverMonths ?? null;
    app = await createTestApp();
    for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
      tokens[key] = await login(app, EMAILS[key]);
    }
    await db.superAdmin.updateMany({
      where: { id: { in: [ids.repA, ids.repB] } },
      data: { twoFactorEnabled: true },
    });
    const cadence = await db.salesCadence.create({
      data: {
        name: `Cadencia ${STAMP}`,
        steps: [{ day: 0, channel: 'call', title: 'Primera llamada' }],
      },
    });
    cadenceId = cadence.id;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.platformSalesSettings.updateMany({
      data: {
        leadReleaseDays: releaseDaysBefore,
        ...(recoverMonthsBefore ? { recoverMonths: recoverMonthsBefore as object } : {}),
      },
    });
    await db.salesCadenceEnrollment.deleteMany({ where: { cadenceId } });
    await db.salesCadence.deleteMany({ where: { id: cadenceId } });
    await db.platformLead.deleteMany({ where: { companyName: { contains: STAMP } } });
    await db.superAdminNotification.deleteMany({ where: { body: { contains: STAMP } } });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await cleanupTestTenants();
    await db.$disconnect();
  });

  it('reglas del equipo: plazos por motivo configurables', async () => {
    const before = await http().get('/admin/sales-team/settings').set(auth(tokens.super));
    expect(before.status).toBe(200);
    expect(before.body.recoverMonths).toEqual(
      expect.objectContaining({ not_now: expect.any(Number), no_response: expect.any(Number) }),
    );
    const res = await http()
      .put('/admin/sales-team/settings')
      .set(auth(tokens.super))
      .send({
        recoverMonths: { not_now: 6, price: 12, competitor: 12, no_response: 3, other: 12 },
      });
    expect(res.status).toBe(200);
    expect(res.body.recoverMonths.no_response).toBe(3);
    const bad = await http()
      .put('/admin/sales-team/settings')
      .set(auth(tokens.super))
      .send({ recoverMonths: { not_now: 0 } });
    expect(bad.status).toBe(400);
    // El comercial lo recibe para proponer la fecha.
    const me = await http().get('/admin/sales/me').set(auth(tokens.repA));
    expect(me.body.recoverMonths.not_now).toBe(6);
  });

  it('«No interesado» lo archiva con la fecha propuesta por el motivo (y editable)', async () => {
    const a = await lead('Archivo Precio');
    const res = await http()
      .post(`/admin/sales/accounts/${a.id}/lose`)
      .set(auth(tokens.repA))
      .send({ reasonCode: 'price', reason: 'Le parece caro' });
    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('lost');
    expect(res.body.lead.salesArchivedAt).not.toBeNull();
    expect(res.body.lead.salesRecoverOn).toBe(madridMonths(12));

    // Fuera de la lista activa, en «Archivados».
    const active = await http()
      .get('/admin/sales/leads')
      .query({ search: STAMP, limit: '100' })
      .set(auth(tokens.repA));
    expect((active.body.items as { id: string }[]).map((i) => i.id)).not.toContain(a.id);
    expect(active.body.archived.total).toBeGreaterThanOrEqual(1);
    const archived = await http()
      .get('/admin/sales/leads')
      .query({ archived: 'true', archive: 'scheduled', search: STAMP })
      .set(auth(tokens.repA));
    expect((archived.body.items as { id: string }[]).map((i) => i.id)).toContain(a.id);

    // Fecha elegida a mano y cambiada después.
    const b = await lead('Archivo Momento');
    const chosen = madridDay(40);
    const lost = await http()
      .post(`/admin/sales/accounts/${b.id}/lose`)
      .set(auth(tokens.repA))
      .send({ reasonCode: 'not_now', recoverOn: chosen });
    expect(lost.body.lead.salesRecoverOn).toBe(chosen);
    const past = await http()
      .patch(`/admin/sales/accounts/${b.id}/archive`)
      .set(auth(tokens.repA))
      .send({ recoverOn: madridDay(0) });
    expect(past.status).toBe(400);
    const moved = await http()
      .patch(`/admin/sales/accounts/${b.id}/archive`)
      .set(auth(tokens.repA))
      .send({ recoverOn: madridDay(10) });
    expect(moved.status).toBe(200);
    expect(moved.body.lead.salesRecoverOn).toBe(madridDay(10));

    // En lote: «No responde» a 3 meses.
    const c = await lead('Archivo Lote');
    const bulk = await http()
      .post('/admin/sales/leads/bulk')
      .set(auth(tokens.repA))
      .send({ leadIds: [c.id], action: { type: 'lose', reasonCode: 'no_response' } });
    expect(bulk.body.done).toBe(1);
    const cRow = await db.platformLead.findUniqueOrThrow({ where: { id: c.id } });
    expect(cRow.salesRecoverOn?.toISOString().slice(0, 10)).toBe(madridMonths(3));
    // Otro comercial no puede tocarlo.
    const other = await http().post(`/admin/sales/accounts/${c.id}/recover`).set(auth(tokens.repB));
    expect(other.status).toBe(404);
  });

  it('los archivados con fecha no quedan libres por inactividad', async () => {
    await db.platformSalesSettings.updateMany({ data: { leadReleaseDays: 30 } });
    const stale = {
      salesAssignedAt: new Date(now - 100 * DAY),
      salesReleaseWarnedAt: new Date(now - 10 * DAY),
    };
    const archived = await lead('Inactivo Archivado', {
      ...stale,
      status: 'lost',
      lostAt: new Date(now - 60 * DAY),
      lostReasonCode: 'price',
      salesArchivedAt: new Date(now - 60 * DAY),
      salesRecoverOn: new Date(`${madridDay(90)}T00:00:00Z`),
    });
    const dnc = await lead('Inactivo Sin Contacto', {
      ...stale,
      status: 'lost',
      lostAt: new Date(now - 60 * DAY),
      lostReasonCode: 'other',
      salesArchivedAt: new Date(now - 60 * DAY),
      doNotContact: true,
    });
    const control = await lead('Inactivo Control', { ...stale, status: 'new' });
    await app.get(SalesAssignmentService).releaseStale();
    const rows = await db.platformLead.findMany({
      where: { id: { in: [archived.id, dnc.id, control.id] } },
      select: { id: true, salesRepId: true },
    });
    const repOf = new Map(rows.map((r) => [r.id, r.salesRepId]));
    expect(repOf.get(archived.id)).toBe(ids.repA);
    expect(repOf.get(dnc.id)).toBe(ids.repA);
    expect(repOf.get(control.id)).toBeNull();
  });

  it('al llegar la fecha sale en «Por hacer» y «Hoy», con aviso, y se recupera', async () => {
    const due = await lead('Para Recuperar', {
      status: 'lost',
      lostAt: new Date(now - 200 * DAY),
      lostReasonCode: 'not_now',
      salesArchivedAt: new Date(now - 200 * DAY),
      salesRecoverOn: new Date(`${madridDay(-1)}T00:00:00Z`),
    });
    await db.platformLeadActivity.create({
      data: { leadId: due.id, type: 'note', content: 'Nota de antes de archivarlo' },
    });
    await db.salesRecovery.create({
      data: {
        leadId: due.id,
        repId: ids.repA,
        kind: 'prospect',
        reasonCode: 'not_now',
        archivedAt: new Date(now - 200 * DAY),
        recoverOn: new Date(`${madridDay(-1)}T00:00:00Z`),
      },
    });

    const queue = await http().get('/admin/sales/queue').set(auth(tokens.repA));
    const item = (queue.body.items as { lead: { id: string }; reason: string }[]).find(
      (i) => i.lead.id === due.id,
    );
    expect(item?.reason).toBe('recover');
    expect(queue.body.counts.recover).toBeGreaterThanOrEqual(1);
    const today = await http().get('/admin/sales/today').set(auth(tokens.repA));
    expect((today.body.toRecover as { leadId: string }[]).map((r) => r.leadId)).toContain(due.id);

    const sent = await app.get(SalesRecoveryService).notifyDue();
    expect(sent).toBeGreaterThanOrEqual(1);
    const notice = await db.superAdminNotification.findFirst({
      where: { recipientId: ids.repA, type: 'sales.recover_due' },
    });
    expect(notice).not.toBeNull();
    // Una vez por fecha.
    await app.get(SalesRecoveryService).notifyDue();
    expect(
      await db.superAdminNotification.count({
        where: { recipientId: ids.repA, type: 'sales.recover_due' },
      }),
    ).toBe(1);

    const recovered = await http()
      .post(`/admin/sales/accounts/${due.id}/recover`)
      .set(auth(tokens.repA));
    expect(recovered.status).toBe(200);
    expect(recovered.body.lead.status).toBe('contacted');
    expect(recovered.body.lead.salesArchivedAt).toBeNull();
    // Con todo su historial.
    const contents = (recovered.body.lead.activities as { content: string }[]).map(
      (a) => a.content,
    );
    expect(contents).toContain('Nota de antes de archivarlo');
    expect(contents).toContain('Recuperado: vuelve a la cartera activa');
    const rec = await db.salesRecovery.findFirstOrThrow({ where: { leadId: due.id } });
    expect(rec.recoveredAt).not.toBeNull();
  });

  it('si el comercial ya no está activo, el aviso va a la dirección', async () => {
    await lead('Recupera Beto', {
      companyName: `Recupera Beto ${STAMP}`,
      salesRepId: ids.repB,
      status: 'lost',
      lostAt: new Date(now - 100 * DAY),
      lostReasonCode: 'price',
      salesArchivedAt: new Date(now - 100 * DAY),
      salesRecoverOn: new Date(`${madridDay(0)}T00:00:00Z`),
    });
    await db.superAdmin.update({ where: { id: ids.repB }, data: { isActive: false } });
    try {
      await app.get(SalesRecoveryService).notifyDue();
      const team = await db.superAdminNotification.findFirst({
        where: {
          recipientId: null,
          type: 'sales.recover_due',
          body: { contains: `Recupera Beto ${STAMP}` },
        },
      });
      expect(team).not.toBeNull();
      expect(
        await db.superAdminNotification.count({
          where: { recipientId: ids.repB, type: 'sales.recover_due' },
        }),
      ).toBe(0);
    } finally {
      await db.superAdmin.update({ where: { id: ids.repB }, data: { isActive: true } });
    }
  });

  it('«No volver a contactar»: sin fecha, sin recordatorios, secuencias, cadencias ni reparto', async () => {
    const d = await lead('Nunca Mas');
    const res = await http()
      .post(`/admin/sales/accounts/${d.id}/lose`)
      .set(auth(tokens.repA))
      .send({ reasonCode: 'other', reason: 'Pide que no le llamemos', doNotContact: true });
    expect(res.status).toBe(200);
    expect(res.body.lead.doNotContact).toBe(true);
    expect(res.body.lead.salesRecoverOn).toBeNull();

    const followup = await http()
      .post(`/admin/sales/accounts/${d.id}/followups`)
      .set(auth(tokens.repA))
      .send({ title: 'Llamar', dueDate: madridDay(2) });
    expect(followup.status).toBe(400);
    expect(followup.body.code).toBe('do_not_contact');
    const cadence = await http()
      .post(`/admin/sales/accounts/${d.id}/cadence`)
      .set(auth(tokens.repA))
      .send({ cadenceId });
    expect(cadence.status).toBe(400);
    await expect(
      app.get(PlatformLeadSequencesService).start(d.id, { byId: null, auto: false }),
    ).rejects.toMatchObject({ response: { code: 'do_not_contact' } });
    expect(
      await app.get(PlatformLeadSequencesService).start(d.id, { byId: null, auto: true }),
    ).toBe(false);

    const list = await http()
      .get('/admin/sales/leads')
      .query({ archived: 'true', archive: 'do_not_contact', search: STAMP })
      .set(auth(tokens.repA));
    expect((list.body.items as { id: string }[]).map((i) => i.id)).toContain(d.id);

    // Sin comercial (la dirección se lo quitó): no se reparte a nadie.
    const free = await lead('Nunca Mas Libre', { salesRepId: null, doNotContact: true });
    const preview = await http()
      .post('/admin/sales-team/distribute/leads')
      .set(auth(tokens.super))
      .send({ leadIds: [free.id], mode: 'single', repId: ids.repA });
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].status).toBe('error');
    expect(preview.body.summary.toAssign).toBe(0);
  });

  it('un cliente que se da de baja se archiva para su comercial y, si vuelve, comisiona a la mitad', async () => {
    await db.salesCommissionPlan.upsert({
      where: { repId: ids.repA },
      create: { repId: ids.repA, revenuePct: 10, perSaleAmount: 50 },
      update: { revenuePct: 10, perSaleAmount: 50 },
    });
    const owner = await registerVerifiedUser(app, `rec${STAMP}`);
    const tenantId = owner.tenantId;
    const firstPaidAt = new Date(now - 20 * DAY);
    await db.tenant.update({
      where: { id: tenantId },
      data: {
        status: 'active',
        salesRepId: ids.repA,
        salesAssignedAt: new Date(now - 40 * DAY),
      },
    });
    const signup = await db.platformLead.findFirstOrThrow({ where: { tenantId } });
    const account = await db.platformLead.update({
      where: { id: signup.id },
      data: {
        companyName: `Cliente Vuelve ${STAMP}`,
        status: 'customer',
        customerAt: firstPaidAt,
        salesRepId: ids.repA,
        salesAssignedAt: new Date(now - 40 * DAY),
      },
    });
    await db.salesAssignment.create({
      data: {
        repId: ids.repA,
        tenantId,
        leadId: account.id,
        source: 'manual',
        startedAt: new Date(now - 40 * DAY),
      },
    });
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'bank_transfer',
        status: 'paid',
        amount: 121,
        paidAt: firstPaidAt,
        description: 'Cuota de la suscripción',
      },
    });
    const commissions = app.get(SalesCommissionsService);
    await commissions.computeTenant(tenantId);

    // Se da de baja.
    await db.tenant.update({
      where: { id: tenantId },
      data: { status: 'cancelled', canceledAt: new Date() },
    });
    const leads = app.get(PlatformLeadsService);
    await leads.syncFromTenants();
    const churned = await db.platformLead.findUniqueOrThrow({ where: { id: account.id } });
    expect(churned.status).toBe('lost');
    expect(churned.lostReasonCode).toBe('churned');
    expect(churned.salesRepId).toBe(ids.repA);
    expect(churned.salesArchivedAt).not.toBeNull();
    expect(churned.salesRecoverOn?.toISOString().slice(0, 10)).toBe(madridMonths(12));
    const archivedNotice = await db.superAdminNotification.findFirst({
      where: { recipientId: ids.repA, type: 'sales.client_churned' },
    });
    expect(archivedNotice).not.toBeNull();

    // Vuelve a contratar.
    await db.tenant.update({
      where: { id: tenantId },
      data: { status: 'active', canceledAt: null },
    });
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'bank_transfer',
        status: 'paid',
        amount: 121,
        paidAt: new Date(),
        description: 'Cuota de la suscripción',
      },
    });
    await leads.syncFromTenants();
    const back = await db.platformLead.findUniqueOrThrow({ where: { id: account.id } });
    expect(back.status).toBe('customer');
    expect(back.salesArchivedAt).toBeNull();
    const recovery = await db.salesRecovery.findFirstOrThrow({
      where: { leadId: account.id, kind: 'client' },
    });
    expect(recovery.wonAt).not.toBeNull();
    expect(recovery.recoveredAt).not.toBeNull();

    await commissions.computeTenant(tenantId);
    const view = await http().get('/admin/sales/commissions').set(auth(tokens.repA));
    expect(view.status).toBe(200);
    const items = view.body.items as {
      kind: string;
      amount: number;
      rate: number | null;
      recovery: boolean;
      tenantId: string;
    }[];
    const mine = items.filter((i) => i.tenantId === tenantId);
    expect(mine.find((i) => i.kind === 'sale')?.amount).toBe(50);
    const fixed = mine.find((i) => i.kind === 'recovery');
    expect(fixed?.amount).toBe(25);
    expect(fixed?.recovery).toBe(true);
    const revenue = mine.filter((i) => i.kind === 'revenue');
    expect(revenue.find((i) => !i.recovery)?.amount).toBeCloseTo(10, 2);
    const half = revenue.find((i) => i.recovery);
    expect(half?.rate).toBe(5);
    expect(half?.amount).toBeCloseTo(5, 2);
    // Recalcular no duplica.
    await commissions.computeTenant(tenantId);
    expect(await db.salesCommissionItem.count({ where: { tenantId, kind: 'recovery' } })).toBe(1);

    // Recuperados en sus resultados y en la comparativa del equipo.
    expect(view.body.recovery.recoveredMonth).toBeGreaterThanOrEqual(2);
    expect(view.body.recovery.wonMonth).toBeGreaterThanOrEqual(1);
    const comparison = await http()
      .get('/admin/sales-team/comparison')
      .query({ months: '1' })
      .set(auth(tokens.super));
    const row = (
      comparison.body.rows as { repId: string; recovered: number; recoveredWon: number }[]
    ).find((r) => r.repId === ids.repA);
    expect(row?.recovered).toBeGreaterThanOrEqual(2);
    expect(row?.recoveredWon).toBeGreaterThanOrEqual(1);
    const team = await http()
      .get('/admin/sales-team/recoveries')
      .query({ repId: ids.repA })
      .set(auth(tokens.super));
    expect((team.body as { kind: string }[]).some((r) => r.kind === 'client')).toBe(true);
  });
});
