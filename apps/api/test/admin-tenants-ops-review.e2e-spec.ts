import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, getMessageHeaders, waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const STAMP = Date.now().toString(36);
const LEAD_DOMAIN = '@ops-review.e2e.local';

/**
 * Arreglos de Seguimientos, Trials, En riesgo y Oportunidades del panel admin
 * (2026-11-25).
 */
describe('Seguimientos, Trials, En riesgo y Oportunidades: arreglos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let adminId: string;
  let salesId: string;

  const http = () => request(app.getHttpServer());
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const atRisk = async () =>
    (await http().get('/admin/tenants/at-risk').set(auth).expect(200)).body;
  const today = async () => (await http().get('/admin/today?fresh=1').set(auth).expect(200)).body;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    await deleteAllMessages();
    await db.platformLead.deleteMany({ where: { email: { endsWith: LEAD_DOMAIN } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('opsreview');
    adminId = admin.id;
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const sales = await seedSuperAdmin('opsreview-sales');
    salesId = sales.id;
    await db.superAdmin.update({ where: { id: salesId }, data: { role: 'sales' } });
  });

  afterAll(async () => {
    await app.close();
    await db.platformLead.deleteMany({ where: { email: { endsWith: LEAD_DOMAIN } } });
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    await deleteAllMessages();
    await db.$disconnect();
  });

  it('seguimientos: los de los comerciales no salen en la bandeja ni en «Hoy»; los nuevos son de quien los crea', async () => {
    const lead = await db.platformLead.create({
      data: { contactName: `Lead ${STAMP}`, email: `lead-${STAMP}${LEAD_DOMAIN}`, source: 'admin' },
    });
    const yesterday = new Date(Date.now() - DAY);
    const [ofSales, ofNobody] = await Promise.all([
      db.platformLeadFollowup.create({
        data: {
          leadId: lead.id,
          title: 'Llamar (comercial)',
          dueDate: yesterday,
          assignedToId: salesId,
        },
      }),
      db.platformLeadFollowup.create({
        data: { leadId: lead.id, title: 'Llamar (sin asignar)', dueDate: yesterday },
      }),
    ]);
    const inbox = await http().get('/admin/leads/followups').set(auth).expect(200);
    expect(ids(inbox.body)).toContain(ofNobody.id);
    expect(ids(inbox.body)).not.toContain(ofSales.id);
    const t = await today();
    expect(ids(t.leadFollowupsDue)).toContain(ofNobody.id);
    expect(ids(t.leadFollowupsDue)).not.toContain(ofSales.id);

    // Un seguimiento de la ficha sin decir quién: lo lleva quien lo crea.
    const owner = await registerVerifiedUser(app, 'opsfollow');
    const due = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const mine = await http()
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({ title: 'Llamar', dueDate: due })
      .expect(201);
    expect(mine.body.assignedToId).toBe(adminId);
    const nobody = await http()
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({ title: 'Llamar sin nadie', dueDate: due, assignedToId: null })
      .expect(201);
    expect(nobody.body.assignedToId).toBeNull();
  });

  it('en riesgo: ignorar oculta solo esa sección, «Hoy» no lo respeta y la lista de ignorados lo enseña', async () => {
    const owner = await registerVerifiedUser(app, 'opssnooze');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'trial', trialEndsAt: new Date(Date.now() + 3 * DAY) },
    });
    await http()
      .post(`/admin/tenants/${owner.tenantId}/risk-snooze`)
      .set(auth)
      .send({ days: 30, reason: 'Ya hablado', kind: 'inactive' })
      .expect(200);
    // Ignorado como inactivo: el fin de prueba sigue saliendo.
    let body = await atRisk();
    expect(ids(body.trialExpiring)).toContain(owner.tenantId);
    const snoozed = body.snoozed.find((s: { id: string }) => s.id === owner.tenantId);
    expect(snoozed).toMatchObject({ kind: 'inactive', reason: 'Ya hablado' });

    await http()
      .post(`/admin/tenants/${owner.tenantId}/risk-snooze`)
      .set(auth)
      .send({ days: 30, reason: 'Ya hablado', kind: 'trial_expiring' })
      .expect(200);
    body = await atRisk();
    expect(ids(body.trialExpiring)).not.toContain(owner.tenantId);
    // «Hoy» no respeta el ignorar de En riesgo.
    expect(ids((await today()).trialsExpiring)).toContain(owner.tenantId);

    await http().delete(`/admin/tenants/${owner.tenantId}/risk-snooze`).set(auth).expect(204);
    body = await atRisk();
    expect(ids(body.trialExpiring)).toContain(owner.tenantId);
    expect(body.snoozed.some((s: { id: string }) => s.id === owner.tenantId)).toBe(false);
  });

  it('una prueba vencida que el cron no ha cerrado sigue en En riesgo, en «Hoy» y en Trials como vencida', async () => {
    const owner = await registerVerifiedUser(app, 'opsexpired');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'trial', trialEndsAt: new Date(Date.now() - 2 * DAY) },
    });
    const row = (await atRisk()).trialExpiring.find((t: { id: string }) => t.id === owner.tenantId);
    expect(row).toMatchObject({ expired: true });
    expect(ids((await today()).trialsExpiring)).toContain(owner.tenantId);
    const trials = await http().get('/admin/tenants/trials').set(auth).expect(200);
    const trial = trials.body.find((t: { id: string }) => t.id === owner.tenantId);
    expect(trial).toMatchObject({ expired: true, daysLeft: -2 });
  });

  it('inactivos solo de pago y con más de 14 días de alta; las pruebas caducadas sin pagar van aparte', async () => {
    const plan = await db.subscriptionPlan.findFirstOrThrow({
      where: { priceMonthly: { gt: 0 }, isActive: true },
      orderBy: { priceMonthly: 'asc' },
    });
    const old = new Date(Date.now() - 40 * DAY);
    const idleSince = new Date(Date.now() - 20 * DAY);
    const makeIdle = async (tenantId: string) => {
      await db.user.updateMany({ where: { tenantId }, data: { lastLoginAt: idleSince } });
      await db.session.updateMany({ where: { tenantId }, data: { lastUsedAt: idleSince } });
    };

    const paying = await registerVerifiedUser(app, 'opspaying');
    await db.tenant.update({
      where: { id: paying.tenantId },
      data: { status: 'active', trialEndsAt: null, createdAt: old },
    });
    await db.tenantSubscription.update({
      where: { tenantId: paying.tenantId },
      data: { status: 'active', planId: plan.id },
    });
    await makeIdle(paying.tenantId);

    // De pago pero recién dado de alta: aún no es «inactivo».
    const fresh = await registerVerifiedUser(app, 'opsfresh');
    await db.tenant.update({
      where: { id: fresh.tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: fresh.tenantId },
      data: { status: 'active', planId: plan.id },
    });
    await makeIdle(fresh.tenantId);

    // Prueba caducada sin pagar (activo en solo lectura).
    const expired = await registerVerifiedUser(app, 'opsreadonly');
    await db.tenant.update({
      where: { id: expired.tenantId },
      data: { status: 'active', createdAt: old, trialEndsAt: new Date(Date.now() - 10 * DAY) },
    });
    await db.tenantSubscription.update({
      where: { tenantId: expired.tenantId },
      data: { status: 'expired' },
    });
    await makeIdle(expired.tenantId);

    const body = await atRisk();
    expect(ids(body.inactive)).toContain(paying.tenantId);
    expect(ids(body.inactive)).not.toContain(fresh.tenantId);
    expect(ids(body.inactive)).not.toContain(expired.tenantId);
    expect(ids(body.trialExpired)).toContain(expired.tenantId);
  });

  it('el lote de pruebas dice cuáles se ha saltado y por qué', async () => {
    const trial = await registerVerifiedUser(app, 'opsbatcht');
    const active = await registerVerifiedUser(app, 'opsbatcha');
    await db.tenant.update({ where: { id: active.tenantId }, data: { status: 'active' } });
    const res = await http()
      .post('/admin/tenants/extend-trials')
      .set(auth)
      .send({ tenantIds: [trial.tenantId, active.tenantId], days: 7, reason: 'Lote e2e' })
      .expect(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toEqual([
      { tenantId: active.tenantId, name: expect.any(String), reason: 'No está en prueba' },
    ]);
  });

  it('proponer un extra: enfriamiento de 14 días, una prueba por extra, sin destinatarios no hace nada y no a suspendidos', async () => {
    const owner = await registerVerifiedUser(app, 'opsoffer');
    const addon = await db.subscriptionAddon.upsert({
      where: { slug: 'e2e-ops-ai' },
      update: { isActive: true },
      create: {
        slug: 'e2e-ops-ai',
        name: 'IA (ops e2e)',
        priceMonthly: 12,
        feature: 'ai_assistant',
      },
    });
    const offer = (tenantId: string, extra: Record<string, unknown> = {}) =>
      http()
        .post(`/admin/tenants/${tenantId}/addon-offers`)
        .set(auth)
        .send({ addonId: addon.id, followupDays: 0, ...extra });

    const first = await offer(owner.tenantId).expect(201);
    expect(first.body.recipients).toBe(1);
    // Es comercial: lleva el enlace de baja y la cabecera de baja de un clic.
    const mail = await waitForEmail(owner.email, { subjectIncludes: 'IA (ops e2e)' });
    expect(mail.Text).toContain('Darme de baja de las novedades y ofertas');
    expect((await getMessageHeaders(mail.ID))['List-Unsubscribe']?.[0]).toContain(
      '/public/unsubscribe/',
    );
    const again = await offer(owner.tenantId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('addon_offer_recent');

    // Una prueba gratis por extra y tenant (aunque la proponga el admin).
    const other = await registerVerifiedUser(app, 'opsoffertrial');
    await db.tenantAddonTrial.create({
      data: {
        tenantId: other.tenantId,
        addonId: addon.id,
        source: 'admin',
        expiresAt: new Date(Date.now() - DAY),
      },
    });
    const trialAgain = await offer(other.tenantId, { trialDays: 7 });
    expect(trialAgain.status).toBe(409);
    expect(trialAgain.body.code).toBe('addon_trial_used');
    const direct = await http()
      .post(`/admin/tenants/${other.tenantId}/addon-trials/${addon.id}`)
      .set(auth)
      .send({ days: 7 });
    expect(direct.status).toBe(409);
    expect(direct.body.code).toBe('addon_trial_used');

    // Se ha dado de baja de las ofertas: nada, ni prueba ni conversación.
    const optedOut = await registerVerifiedUser(app, 'opsofferout');
    await db.user.updateMany({
      where: { tenantId: optedOut.tenantId },
      data: { platformNewsOptOutAt: new Date() },
    });
    const none = await offer(optedOut.tenantId, { trialDays: 7, followupDays: 7 });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('no_recipients');
    expect(
      await db.tenantFeatureOverride.count({
        where: { tenantId: optedOut.tenantId, feature: 'ai_assistant' },
      }),
    ).toBe(0);
    expect(await db.tenantInteraction.count({ where: { tenantId: optedOut.tenantId } })).toBe(0);
    expect(await db.tenantFollowup.count({ where: { tenantId: optedOut.tenantId } })).toBe(0);

    // A un suspendido no se le propone nada (ni sale como candidato).
    const suspended = await registerVerifiedUser(app, 'opsoffersusp');
    await db.tenant.update({ where: { id: suspended.tenantId }, data: { status: 'suspended' } });
    const susp = await offer(suspended.tenantId);
    expect(susp.status).toBe(400);
    expect(susp.body.code).toBe('tenant_not_live');
  });

  it('oportunidades: cámaras solo si usa el control de accesos de verdad', async () => {
    const owner = await registerVerifiedUser(app, 'opscams');
    await setTenantPlan(owner.slug, 'starter');
    const addon = await db.subscriptionAddon.upsert({
      where: { slug: 'e2e-ops-cameras' },
      update: { isActive: true },
      create: {
        slug: 'e2e-ops-cameras',
        name: 'Cámaras (ops e2e)',
        priceMonthly: 24,
        feature: 'cameras',
      },
    });
    const candidates = async () => {
      const ops = await http().get('/admin/opportunities').set(auth).expect(200);
      const row = ops.body.find((o: { addonId: string }) => o.addonId === addon.id);
      return (row?.candidates ?? []).map((c: { tenantId: string }) => c.tenantId);
    };
    expect(await candidates()).not.toContain(owner.tenantId);

    const facility = await http()
      .post('/facilities')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ name: `Local ${STAMP}`, city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(201);
    await db.accessDevice.create({
      data: {
        tenantId: owner.tenantId,
        facilityId: facility.body.id,
        type: 'door',
        name: 'Puerta',
        hardwareId: `hw-${STAMP}`,
      },
    });
    expect(await candidates()).toContain(owner.tenantId);
  });
});
