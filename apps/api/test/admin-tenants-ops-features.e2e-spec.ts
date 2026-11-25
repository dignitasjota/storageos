import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-ops-features@storageos.local';
const REP_EMAIL = 'rep-ops-features@storageos.local';
const DAY = 86_400_000;

const madridDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const plusDays = (n: number) => madridDay(new Date(Date.now() + n * DAY));

describe('Seguimientos, Trials, En riesgo y Oportunidades: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let adminId: string;
  let repId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, REP_EMAIL] } } });
    const admin = await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Ops Features',
        role: 'superadmin',
      },
    });
    adminId = admin.id;
    const rep = await db.superAdmin.create({
      data: {
        email: REP_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Comercial Ops',
        role: 'sales',
      },
    });
    repId = rep.id;
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await db.platformLead.deleteMany({ where: { email: { startsWith: 'ops-feat-' } } });
    await db.superAdminNotification.deleteMany({ where: { recipientId: repId } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, REP_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('seguimientos: crear, editar, en lote y hecho con «qué pasó»', async () => {
    const owner = await registerVerifiedUser(app, 'opsfu');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const lead = await db.platformLead.create({
      data: { companyName: 'Lead Ops Feat', email: `ops-feat-${Date.now()}@example.com` },
    });
    const server = app.getHttpServer();

    // Tenant: sin decir quién, lo lleva quien lo crea.
    const t = await request(server)
      .post('/admin/followups')
      .set(auth())
      .send({ kind: 'tenant', subjectId: tenant.id, title: 'Llamar', dueDate: madridDay() })
      .expect(201);
    expect(t.body).toMatchObject({ kind: 'tenant', assignedToId: adminId, status: 'pending' });
    const l = await request(server)
      .post('/admin/followups')
      .set(auth())
      .send({ kind: 'lead', subjectId: lead.id, title: 'Enviar demo', dueDate: plusDays(5) })
      .expect(201);
    expect(l.body).toMatchObject({ kind: 'lead', subjectName: 'Lead Ops Feat' });
    // Fecha pasada: no.
    await request(server)
      .post('/admin/followups')
      .set(auth())
      .send({ kind: 'tenant', subjectId: tenant.id, title: 'X', dueDate: plusDays(-2) })
      .expect(400);
    // Un comercial no lleva seguimientos de tenants.
    await request(server)
      .post('/admin/followups')
      .set(auth())
      .send({
        kind: 'tenant',
        subjectId: tenant.id,
        title: 'X',
        dueDate: madridDay(),
        assignedToId: repId,
      })
      .expect(400);

    const today = await request(server)
      .get(`/admin/followups/inbox?tab=today&search=${encodeURIComponent(tenant.name)}`)
      .set(auth())
      .expect(200);
    expect(today.body.items.map((i: { id: string }) => i.id)).toContain(t.body.id);
    const upcoming = await request(server)
      .get('/admin/followups/inbox?tab=upcoming&kind=lead&search=Lead%20Ops%20Feat')
      .set(auth())
      .expect(200);
    expect(upcoming.body.items).toHaveLength(1);
    expect(upcoming.body.counts.upcoming).toBe(1);

    // Editar título, nota y responsable.
    const edited = await request(server)
      .patch(`/admin/followups/items/tenant/${t.body.id}`)
      .set(auth())
      .send({ title: 'Llamar al dueño', note: 'Por la mañana', assignedToId: null })
      .expect(200);
    expect(edited.body).toMatchObject({ title: 'Llamar al dueño', note: 'Por la mañana' });
    expect(edited.body.assignedToId).toBeNull();

    // Atrasado sin asignar: cuenta en el aviso del menú.
    const before = (await request(server).get('/admin/followups/overdue-count').set(auth())).body
      .count as number;
    await db.tenantFollowup.create({
      data: {
        tenantId: tenant.id,
        title: 'Atrasado',
        dueDate: new Date(`${plusDays(-3)}T00:00:00Z`),
      },
    });
    const after = await request(server).get('/admin/followups/overdue-count').set(auth());
    expect(after.body.count).toBe(before + 1);

    // Posponer en lote los dos.
    const bulk = await request(server)
      .post('/admin/followups/bulk')
      .set(auth())
      .send({
        items: [
          { kind: 'tenant', id: t.body.id },
          { kind: 'lead', id: l.body.id },
        ],
        action: 'postpone',
        days: 7,
      })
      .expect(200);
    expect(bulk.body).toEqual({ updated: 2, skipped: 0 });
    const moved = await db.tenantFollowup.findUniqueOrThrow({ where: { id: t.body.id } });
    expect(moved.dueDate.toISOString().slice(0, 10)).toBe(plusDays(7));

    // Hecho con «qué pasó»: queda en la conversación del tenant.
    const done = await request(server)
      .patch(`/admin/followups/items/tenant/${t.body.id}`)
      .set(auth())
      .send({ status: 'done', outcome: 'Lo pensará esta semana' })
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'done',
      outcome: 'Lo pensará esta semana',
      completedByName: 'Admin Ops Features',
    });
    const note = await db.tenantInteraction.findFirst({
      where: { tenantId: tenant.id, content: { contains: 'Lo pensará esta semana' } },
    });
    expect(note).not.toBeNull();
    // Y en el lead, como actividad.
    await request(server)
      .post('/admin/followups/bulk')
      .set(auth())
      .send({ items: [{ kind: 'lead', id: l.body.id }], action: 'done', outcome: 'Demo enviada' })
      .expect(200);
    const activity = await db.platformLeadActivity.findFirst({
      where: { leadId: lead.id, content: { contains: 'Demo enviada' } },
    });
    expect(activity).not.toBeNull();
    const doneTab = await request(server)
      .get(`/admin/followups/inbox?tab=done&search=${encodeURIComponent(tenant.name)}`)
      .set(auth())
      .expect(200);
    expect(doneTab.body.items[0]).toMatchObject({
      id: t.body.id,
      outcome: 'Lo pensará esta semana',
    });
    // Reabrir borra lo de cerrado.
    const reopened = await request(server)
      .patch(`/admin/followups/items/tenant/${t.body.id}`)
      .set(auth())
      .send({ status: 'pending' })
      .expect(200);
    expect(reopened.body).toMatchObject({ status: 'pending', outcome: null, completedAt: null });
  });

  it('trials: búsqueda, filtros, progreso y caducadas sin pagar', async () => {
    const owner = await registerVerifiedUser(app, 'opstr');
    const tenant = await db.tenant.update({
      where: { slug: owner.slug },
      data: { status: 'trial', trialEndsAt: new Date(Date.now() - DAY), salesRepId: repId },
    });
    const server = app.getHttpServer();
    const page = await request(server)
      .get(`/admin/trials?search=${owner.slug}`)
      .set(auth())
      .expect(200);
    expect(page.body.total).toBe(1);
    const row = page.body.items[0];
    expect(row).toMatchObject({ id: tenant.id, salesRepName: 'Comercial Ops' });
    expect(row.progress.total).toBe(6);
    expect(row.progress.missing).toContain('Local');
    expect(['high', 'medium', 'low']).toContain(row.conversion.level);
    expect(page.body.counts.expired).toBe(1);
    expect(page.body.counts.this_week).toBe(0);
    expect(typeof page.body.summary.inProgress).toBe('number');
    const expiredOnly = await request(server)
      .get(`/admin/trials?search=${owner.slug}&filter=expired`)
      .set(auth())
      .expect(200);
    expect(expiredOnly.body.items).toHaveLength(1);
    await request(server).get('/admin/trials?filter=nope').set(auth()).expect(400);
    // Filtro por comercial.
    const byRep = await request(server)
      .get(`/admin/trials?salesRepId=${repId}&search=${owner.slug}`)
      .set(auth())
      .expect(200);
    expect(byRep.body.total).toBe(1);

    // Prueba que terminó sin pagar: activa con la suscripción caducada.
    await db.tenant.update({ where: { id: tenant.id }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { status: 'expired' },
    });
    const expired = await request(server).get('/admin/trials/expired').set(auth()).expect(200);
    const mine = expired.body.find((t: { id: string }) => t.id === tenant.id);
    expect(mine).toMatchObject({ salesRepName: 'Comercial Ops' });
    expect(mine.endedAt).not.toBeNull();
    expect(mine.daysSince).toBeGreaterThanOrEqual(0);
  });

  it('en riesgo: dinero, responsable, último contacto, bajas programadas y playbook por motivo', async () => {
    const owner = await registerVerifiedUser(app, 'opsrisk');
    const tenant = await db.tenant.update({
      where: { slug: owner.slug },
      data: { status: 'active', cancelScheduledAt: new Date(Date.now() + 10 * DAY) },
    });
    const owner2 = await registerVerifiedUser(app, 'opsrisk2');
    const t2 = await db.tenant.update({ where: { slug: owner2.slug }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: t2.id },
      data: {
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
      },
    });
    await db.tenantFollowup.create({
      data: {
        tenantId: t2.id,
        title: 'Llamar',
        dueDate: new Date(`${plusDays(2)}T00:00:00Z`),
        assignedToId: adminId,
      },
    });
    await db.tenantInteraction.create({
      data: { tenantId: t2.id, superAdminId: adminId, type: 'call', content: 'Hablado' },
    });
    const server = app.getHttpServer();
    const res = await request(server).get('/admin/tenants/at-risk').set(auth()).expect(200);
    expect(typeof res.body.monthlyAtStake).toBe('number');
    const scheduled = res.body.scheduledEnd.find((r: { id: string }) => r.id === tenant.id);
    expect(scheduled).toMatchObject({ reason: 'scheduled_end' });
    expect(typeof scheduled.monthly).toBe('number');
    const cancelling = res.body.cancelAtPeriodEnd.find((r: { id: string }) => r.id === t2.id);
    expect(cancelling).toMatchObject({
      ownerId: adminId,
      ownerSource: 'followup',
      lastContactType: 'call',
    });
    // Ordenado por cuota de más a menos.
    for (const key of ['scheduledEnd', 'cancelAtPeriodEnd', 'pastDue', 'inactive']) {
      const list = (res.body[key] ?? []) as { monthly: number }[];
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1]!.monthly).toBeGreaterThanOrEqual(list[i]!.monthly);
      }
    }

    const preview = await request(server)
      .post(`/admin/tenants/${t2.id}/retention-playbook/preview`)
      .set(auth())
      .send({ reason: 'past_due', message: 'Te llamé ayer' })
      .expect(200);
    expect(preview.body.subject).toContain('cobrar');
    expect(preview.body.body).toContain('Te llamé ayer');
    expect(preview.body.recipients.length).toBeGreaterThan(0);

    await db.tenantFollowup.deleteMany({ where: { tenantId: t2.id } });
    await request(server)
      .post(`/admin/tenants/${t2.id}/retention-playbook`)
      .set(auth())
      .send({ reason: 'cancel_at_period_end' })
      .expect(200);
    const log = await db.superAdminAuditLog.findFirst({
      where: { targetTenantId: t2.id, action: 'admin.tenant.retention_playbook' },
    });
    expect((log?.changes as { reason?: string }).reason).toBe('cancel_at_period_end');
    // Ignorar solo «Baja programada»; y el playbook lanzado se ve en la fila.
    await request(server)
      .post(`/admin/tenants/${tenant.id}/risk-snooze`)
      .set(auth())
      .send({ days: 30, reason: 'Ya hablado', kind: 'scheduled_end' })
      .expect(200);
    const again = await request(server).get('/admin/tenants/at-risk').set(auth()).expect(200);
    expect(again.body.scheduledEnd.some((r: { id: string }) => r.id === tenant.id)).toBe(false);
    expect(
      again.body.snoozed.some(
        (r: { id: string; kind: string }) => r.id === tenant.id && r.kind === 'scheduled_end',
      ),
    ).toBe(true);
    const launched = again.body.cancelAtPeriodEnd.find((r: { id: string }) => r.id === t2.id);
    expect(launched.playbookAt).toBeTruthy();
    // Sigue el enfriamiento de 14 días.
    await db.tenantFollowup.deleteMany({ where: { tenantId: t2.id } });
    await request(server)
      .post(`/admin/tenants/${t2.id}/retention-playbook`)
      .set(auth())
      .send({ reason: 'cancel_at_period_end' })
      .expect(409);
  });

  it('oportunidades: descartar, propuesta a varios, estado y paso al comercial', async () => {
    const addon = await db.subscriptionAddon.upsert({
      where: { slug: 'e2e-ops-sepa' },
      update: { isActive: true, priceMonthly: 9 },
      create: {
        slug: 'e2e-ops-sepa',
        name: 'Remesas SEPA (ops)',
        priceMonthly: 9,
        feature: 'sepa',
      },
    });
    const a = await registerVerifiedUser(app, 'opsopa');
    const b = await registerVerifiedUser(app, 'opsopb');
    const ta = await db.tenant.update({ where: { slug: a.slug }, data: { status: 'active' } });
    const tb = await db.tenant.update({ where: { slug: b.slug }, data: { status: 'suspended' } });
    await db.featureInterestEvent.createMany({
      data: [
        { tenantId: ta.id, feature: 'sepa' },
        { tenantId: tb.id, feature: 'sepa' },
      ],
    });
    const server = app.getHttpServer();
    const find = async () => {
      const res = await request(server)
        .get('/admin/opportunities/overview')
        .set(auth())
        .expect(200);
      const row = res.body.addons.find((x: { addonId: string }) => x.addonId === addon.id);
      return { body: res.body, row };
    };
    let { body, row } = await find();
    expect(typeof body.pricesIncludeVat).toBe('boolean');
    const cand = row.candidates.find((c: { tenantId: string }) => c.tenantId === ta.id);
    expect(cand).toMatchObject({ offer: null });
    expect(row.potentialMonthly).toBe(9 * row.candidates.length);
    expect(body.byTenant.some((t: { tenantId: string }) => t.tenantId === ta.id)).toBe(true);

    // Descartar y deshacer.
    const dis = await request(server)
      .post('/admin/opportunities/dismissals')
      .set(auth())
      .send({ tenantId: ta.id, addonId: addon.id, days: 30, reason: 'Usa otro banco' })
      .expect(201);
    ({ body, row } = await find());
    expect((row?.candidates ?? []).some((c: { tenantId: string }) => c.tenantId === ta.id)).toBe(
      false,
    );
    expect(body.dismissals.some((d: { id: string }) => d.id === dis.body.id)).toBe(true);
    await request(server)
      .delete(`/admin/opportunities/dismissals/${dis.body.id}`)
      .set(auth())
      .expect(204);

    // Propuesta a varios: el suspendido se salta.
    const preview = await request(server)
      .post('/admin/opportunities/bulk-propose/preview')
      .set(auth())
      .send({ addonId: addon.id, tenantIds: [ta.id, tb.id] })
      .expect(200);
    expect(preview.body.willSend.map((w: { tenantId: string }) => w.tenantId)).toEqual([ta.id]);
    expect(preview.body.skipped[0]).toMatchObject({ tenantId: tb.id });
    const sent = await request(server)
      .post('/admin/opportunities/bulk-propose')
      .set(auth())
      .send({ addonId: addon.id, tenantIds: [ta.id, tb.id], followupDays: 0 })
      .expect(200);
    expect(sent.body.sent).toBe(1);
    const offer = await db.platformAddonOffer.findFirst({
      where: { tenantId: ta.id, addonId: addon.id },
    });
    expect(offer).toMatchObject({ source: 'bulk' });
    ({ row } = await find());
    const after = row.candidates.find((c: { tenantId: string }) => c.tenantId === ta.id);
    expect(after.offer.status).toBe('sent');
    expect(row.acceptance.sent).toBeGreaterThanOrEqual(1);
    // Volver a proponer en 14 días: se salta.
    const again = await request(server)
      .post('/admin/opportunities/bulk-propose/preview')
      .set(auth())
      .send({ addonId: addon.id, tenantIds: [ta.id] })
      .expect(200);
    expect(again.body.willSend).toHaveLength(0);

    // Pasar al comercial: sin comercial no; con él, seguimiento en su prospecto y aviso.
    await request(server)
      .post('/admin/opportunities/hand-off')
      .set(auth())
      .send({ tenantId: ta.id, addonId: addon.id })
      .expect(400);
    await db.tenant.update({ where: { id: ta.id }, data: { salesRepId: repId } });
    // Al registrarse ya tiene su lead: se le pone el comercial.
    const existing = await db.platformLead.findFirst({ where: { tenantId: ta.id } });
    const lead = existing
      ? await db.platformLead.update({ where: { id: existing.id }, data: { salesRepId: repId } })
      : await db.platformLead.create({
          data: {
            companyName: 'Prospecto Ops',
            email: `ops-feat-hand-${Date.now()}@example.com`,
            tenantId: ta.id,
            salesRepId: repId,
          },
        });
    const hand = await request(server)
      .post('/admin/opportunities/hand-off')
      .set(auth())
      .send({ tenantId: ta.id, addonId: addon.id, note: 'Le interesa' })
      .expect(200);
    expect(hand.body.salesRepName).toBe('Comercial Ops');
    const fu = await db.platformLeadFollowup.findUniqueOrThrow({
      where: { id: hand.body.followupId },
    });
    expect(fu).toMatchObject({ leadId: lead.id, assignedToId: repId });
    const notice = await db.superAdminNotification.findFirst({
      where: { recipientId: repId, type: 'sales.opportunity' },
    });
    expect(notice).not.toBeNull();
  });

  it('sin token: 401', async () => {
    const server = app.getHttpServer();
    await request(server).get('/admin/followups/inbox').expect(401);
    await request(server).get('/admin/trials').expect(401);
    await request(server).get('/admin/tenants/at-risk').expect(401);
    await request(server).get('/admin/opportunities/overview').expect(401);
  });
});
