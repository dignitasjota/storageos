import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminQuoteService } from '../src/modules/admin/admin-quote.service';
import { SalesAssignmentService } from '../src/modules/admin/sales/sales-assignment.service';
import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';
import { CommunicationsService } from '../src/modules/communications/communications.service';

import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `sales-super-${STAMP}@storageos.local`,
  support: `sales-support-${STAMP}@storageos.local`,
  repA: `sales-a-${STAMP}@storageos.local`,
  repB: `sales-b-${STAMP}@storageos.local`,
};

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: PASSWORD });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

/** Alta en la web con (o sin) código de comercial. Devuelve el tenant y su token. */
async function register(
  app: INestApplication,
  prefix: string,
  salesCode?: string,
  salesCodeFrom: 'link' | 'typed' = 'link',
  emailOverride?: string,
): Promise<{ tenantId: string; slug: string; email: string; accessToken: string }> {
  const ids = uniqueTestIds(prefix);
  const email = emailOverride ?? ids.email;
  const reg = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      tenantName: `Test ${prefix}`,
      tenantSlug: ids.slug,
      fullName: 'Dueño Prueba',
      email,
      password: 'Secret123',
      acceptTerms: true,
      ...(salesCode ? { salesCode, salesCodeFrom } : {}),
    });
  if (reg.status !== 201) throw new Error(`register: ${reg.status} ${JSON.stringify(reg.body)}`);
  const mail = await waitForEmail(email, { subjectIncludes: 'Verifica' });
  const token = extractToken(mail.Text, '/verify-email');
  const verified = await request(app.getHttpServer()).post('/auth/verify-email').send({ token });
  if (verified.status !== 200) throw new Error(`verify: ${verified.status}`);
  return {
    tenantId: verified.body.tenant.id as string,
    slug: ids.slug,
    email,
    accessToken: verified.body.accessToken as string,
  };
}

describe('Comerciales (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let superToken: string;
  let supportToken: string;
  let repAToken: string;
  let repBToken: string;
  let repAId: string;
  let repBId: string;
  let repACode: string;
  let addonId: string;
  let starterPlanId: string;
  const couponOk = `SALESOK${STAMP}`.toUpperCase().slice(0, 30);
  const couponNo = `SALESNO${STAMP}`.toUpperCase().slice(0, 30);
  let paidTenantId: string;
  let paidLeadId: string;
  let ownerToken: string;
  let prospectLeadId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    await db.superAdmin.create({
      data: { email: EMAILS.super, passwordHash, fullName: 'Dirección', role: 'superadmin' },
    });
    await db.superAdmin.create({
      data: { email: EMAILS.support, passwordHash, fullName: 'Soporte', role: 'support' },
    });
    const a = await db.superAdmin.create({
      data: { email: EMAILS.repA, passwordHash, fullName: 'Ana Comercial', role: 'sales' },
    });
    const b = await db.superAdmin.create({
      data: { email: EMAILS.repB, passwordHash, fullName: 'Beto Ventas', role: 'sales' },
    });
    repAId = a.id;
    repBId = b.id;
    const addon = await db.subscriptionAddon.create({
      data: { slug: `test-sales-addon-${STAMP}`, name: `Extra ventas ${STAMP}`, priceMonthly: 20 },
    });
    addonId = addon.id;
    starterPlanId = (await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } }))
      .id;
    await db.platformCoupon.create({
      data: { code: couponOk, discountType: 'percentage', discountValue: 10, salesAllowed: true },
    });
    await db.platformCoupon.create({
      data: { code: couponNo, discountType: 'percentage', discountValue: 50 },
    });
    // Ajustes del equipo como empiezan en una instalación nueva.
    await db.platformSalesSettings.updateMany({
      data: {
        signupExtraTrialDays: 0,
        leadReleaseDays: 90,
        repTrialExtensionDays: 14,
        repAddonTrialDays: 14,
        demoTenantId: null,
      },
    });
    app = await createTestApp();
    superToken = await login(app, EMAILS.super);
    supportToken = await login(app, EMAILS.support);
    repAToken = await login(app, EMAILS.repA);
    repBToken = await login(app, EMAILS.repB);
  });

  afterAll(async () => {
    await app.close();
    await db.platformSalesSettings.updateMany({ data: { demoTenantId: null } });
    await db.platformQuoteOffer.deleteMany({ where: { superAdminId: { in: [repAId, repBId] } } });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await db.platformCoupon.deleteMany({ where: { code: { in: [couponOk, couponNo] } } });
    await cleanupTestTenants();
    await db.tenantSubscriptionAddon.deleteMany({ where: { addonId } });
    await db.subscriptionAddon.deleteMany({ where: { id: addonId } });
    await db.$disconnect();
  });

  it('un comercial necesita la verificación en dos pasos y solo llega a sus pantallas', async () => {
    // Sin 2FA: su cuenta sí; sus pantallas no.
    const me = await http().get('/admin/auth/me').set('Authorization', `Bearer ${repAToken}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('sales');
    const blocked = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repAToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('admin_two_factor_required');

    await db.superAdmin.updateMany({
      where: { id: { in: [repAId, repBId] } },
      data: { twoFactorEnabled: true },
    });
    const ok = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repAToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.salesCode).toMatch(/^[A-Z0-9]{4,12}$/);
    expect(ok.body.signupUrl).toContain(`team=${ok.body.salesCode}`);
    repACode = ok.body.salesCode;

    // El resto del panel le está cerrado.
    for (const path of [
      '/admin/tenants',
      '/admin/platform/notifications',
      '/admin/metrics',
      '/admin/leads',
      '/admin/sales-team',
    ]) {
      const res = await http().get(path).set('Authorization', `Bearer ${repAToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('sales_not_allowed');
    }
    // Soporte no usa las pantallas de comercial ni las de dirección comercial.
    const support = await http()
      .get('/admin/sales/me')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(support.status).toBe(403);
    expect(support.body.code).toBe('sales_only');
    const supportTeam = await http()
      .get('/admin/sales-team')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(supportTeam.status).toBe(403);

    // Código público.
    const check = await http().get(`/public/sales/code/${repACode.toLowerCase()}`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ valid: true, repName: 'Ana Comercial' });
    const bad = await http().get('/public/sales/code/NOEXISTE');
    expect(bad.body.valid).toBe(false);
  });

  it('el código del comercial le asigna la cuenta; sin código, nadie', async () => {
    await http()
      .put('/admin/sales-team/settings')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ signupExtraTrialDays: 15 })
      .expect(200);

    const withCode = await register(app, 'salescode', repACode);
    ownerToken = withCode.accessToken;
    paidTenantId = withCode.tenantId;
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: withCode.tenantId } });
    expect(tenant.salesRepId).toBe(repAId);
    expect(tenant.salesSource).toBe('link');
    // 30 días de prueba + 15 por venir con el código.
    const days = Math.round((tenant.trialEndsAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(44);
    const lead = await db.platformLead.findUniqueOrThrow({
      where: { tenantId: withCode.tenantId },
    });
    paidLeadId = lead.id;
    expect(lead.salesRepId).toBe(repAId);

    const noCode = await register(app, 'salesnocode');
    const free = await db.tenant.findUniqueOrThrow({ where: { id: noCode.tenantId } });
    expect(free.salesRepId).toBeNull();

    // El comercial A la ve; el B no existe para él.
    const clients = await http()
      .get('/admin/sales/clients')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(clients.status).toBe(200);
    expect(clients.body.map((c: { tenantId: string }) => c.tenantId)).toContain(withCode.tenantId);
    const other = await http()
      .get(`/admin/sales/accounts/${paidLeadId}`)
      .set('Authorization', `Bearer ${repBToken}`);
    expect(other.status).toBe(404);
    const mine = await http()
      .get(`/admin/sales/accounts/${paidLeadId}`)
      .set('Authorization', `Bearer ${repAToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.client.tenantId).toBe(withCode.tenantId);
    expect(mine.body.pendingAssignment).toBe(false);

    // Un aviso de la cuenta del comercial no llega al feed de la dirección.
    const repFeed = await http()
      .get('/admin/sales/notifications')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(repFeed.body.items.some((n: { type: string }) => n.type === 'sales.signup')).toBe(true);
    const teamFeed = await http()
      .get('/admin/platform/notifications/page')
      .set('Authorization', `Bearer ${superToken}`);
    expect(teamFeed.body.items.some((n: { type: string }) => n.type === 'sales.signup')).toBe(
      false,
    );

    // «Tu comercial» en el panel del cliente.
    const rep = await http()
      .get('/v1/settings/sales-rep')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(rep.status).toBe(200);
    expect(rep.body.rep).toMatchObject({ fullName: 'Ana Comercial', email: EMAILS.repA });
  });

  it('el formulario de la web con código es del comercial y los duplicados no se reparten', async () => {
    const meB = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repBToken}`);
    const contactEmail = `contacto-${STAMP}@e2e.local`;
    await http()
      .post('/platform-contact')
      .send({
        kind: 'demo',
        name: 'Carla Contacto',
        email: contactEmail,
        phone: '600111222',
        company: 'Trasteros Carla',
        acceptPrivacy: true,
        salesCode: meB.body.salesCode,
      })
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    const lead = await db.platformLead.findFirstOrThrow({ where: { email: contactEmail } });
    expect(lead.salesRepId).toBe(repBId);

    // A no puede darlo de alta otra vez ni saber de quién es.
    const dup = await http()
      .post('/admin/sales/leads')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ companyName: 'Otro nombre', email: contactEmail });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('lead_exists');
    expect(JSON.stringify(dup.body)).not.toContain(repBId);
  });

  it('cartera: prospecto, resultado de la llamada, «Hoy», cadencia, importar y crear su cuenta', async () => {
    const prospectEmail = `prospecto-${STAMP}@e2e.local`;
    const created = await http()
      .post('/admin/sales/leads')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({
        companyName: 'Trasteros del Sur',
        contactName: 'Pedro Sur',
        email: prospectEmail,
        phone: '611222333',
      });
    expect(created.status).toBe(201);
    prospectLeadId = created.body.lead.id;

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const outcome = await http()
      .post(`/admin/sales/accounts/${prospectLeadId}/outcome`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ outcome: 'interested', note: 'Quiere ver precios', followupDate: today });
    expect(outcome.status).toBe(201);
    expect(outcome.body.profile.lastOutcome).toBe('interested');
    expect(outcome.body.profile.temperature).toBe('hot');
    expect(outcome.body.lead.status).toBe('interested');

    const profile = await http()
      .put(`/admin/sales/accounts/${prospectLeadId}/profile`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({
        pinnedNote: 'Tiene 120 trasteros en Sevilla',
        decisionMaker: 'Pedro',
        bestTime: 'Mañanas',
      });
    expect(profile.body.profile.pinnedNote).toBe('Tiene 120 trasteros en Sevilla');

    const todayRes = await http()
      .get('/admin/sales/today')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(todayRes.status).toBe(200);
    expect(
      todayRes.body.followups.some((f: { leadId: string }) => f.leadId === prospectLeadId),
    ).toBe(true);

    // Cadencia: crea un seguimiento por paso y se puede parar.
    const cadences = await http()
      .get('/admin/sales/cadences')
      .set('Authorization', `Bearer ${repAToken}`);
    const cold = cadences.body.find((c: { name: string }) => c.name === 'Prospecto en frío');
    expect(cold).toBeTruthy();
    const enrolled = await http()
      .post(`/admin/sales/accounts/${prospectLeadId}/cadence`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ cadenceId: cold.id });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.cadence.steps).toHaveLength(cold.steps.length);
    const again = await http()
      .post(`/admin/sales/accounts/${prospectLeadId}/cadence`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ cadenceId: cold.id });
    expect(again.status).toBe(409);
    const stopped = await http()
      .delete(`/admin/sales/accounts/${prospectLeadId}/cadence`)
      .set('Authorization', `Bearer ${repAToken}`);
    expect(stopped.body.cadence.status).toBe('stopped');

    // Importar prospectos: uno nuevo y uno repetido.
    const csv = `empresa;contacto;email;telefono\nNueva Trastería;Luis;nueva-${STAMP}@e2e.local;\nRepetida;Pedro;${prospectEmail};\n`;
    const preview = await http()
      .post('/admin/sales/leads/import')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ csv });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ valid: 1, duplicates: 1, created: 0 });
    const commit = await http()
      .post('/admin/sales/leads/import')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ csv, commit: true });
    expect(commit.body.created).toBe(1);

    // Resumen para la llamada.
    const summary = await http()
      .get(`/admin/sales/accounts/${prospectLeadId}/summary`)
      .set('Authorization', `Bearer ${repAToken}`);
    expect(summary.body.lines.join(' ')).toContain('Tiene 120 trasteros en Sevilla');

    // El comercial crea la cuenta: queda en su cartera.
    const tenant = await http()
      .post(`/admin/sales/accounts/${prospectLeadId}/create-tenant`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({
        tenantName: 'Trasteros del Sur',
        ownerName: 'Pedro Sur',
        ownerEmail: `owner-sur-${STAMP}@e2e.local`,
      });
    expect(tenant.status).toBe(201);
    expect(tenant.body.client).toBeTruthy();
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenant.body.client.tenantId } });
    expect(t.salesRepId).toBe(repAId);
    expect(t.salesSource).toBe('created');
    // Para que la limpieza la borre.
    await db.tenant.update({ where: { id: t.id }, data: { slug: `test-sales-sur-${STAMP}` } });
  });

  it('cartera: duplicados al editar, «Ninguno», notas sin fecha futura y liberación', async () => {
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const ofB = `de-beto-${STAMP}@e2e.local`;
    await http()
      .post('/admin/sales/leads')
      .set(auth(repBToken))
      .send({ companyName: 'De Beto', email: ofB })
      .expect(201);
    const phone = `6${Date.now().toString().slice(-8)}`;
    const mine = await http()
      .post('/admin/sales/leads')
      .set(auth(repAToken))
      .send({ companyName: 'Solo teléfono', phone: phone });
    expect(mine.status).toBe(201);
    const leadId = mine.body.lead.id as string;
    // Ponerle el email de un prospecto de otro comercial no se puede.
    const dup = await http()
      .patch(`/admin/sales/accounts/${leadId}`)
      .set(auth(repAToken))
      .send({ email: ofB.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('lead_exists');
    // Su propio teléfono sí (no cambia).
    await http()
      .patch(`/admin/sales/accounts/${leadId}`)
      .set(auth(repAToken))
      .send({
        phone: `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`,
        city: 'Sevilla',
      })
      .expect(200);

    // «Ninguno»: no se crea seguimiento.
    await http()
      .post(`/admin/sales/accounts/${leadId}/outcome`)
      .set(auth(repAToken))
      .send({ outcome: 'no_answer', followupDate: null })
      .expect(201);
    expect(await db.platformLeadFollowup.count({ where: { leadId, status: 'pending' } })).toBe(0);
    // Con «No interesado», la fecha elegida sí cuenta.
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('sv-SE', {
      timeZone: 'Europe/Madrid',
    });
    await http()
      .post(`/admin/sales/accounts/${leadId}/outcome`)
      .set(auth(repAToken))
      .send({ outcome: 'not_interested', followupDate: inAWeek })
      .expect(201);
    expect(await db.platformLeadFollowup.count({ where: { leadId, status: 'pending' } })).toBe(1);

    // Una nota con fecha futura no se admite.
    const future = await http()
      .post(`/admin/sales/accounts/${leadId}/activities`)
      .set(auth(repAToken))
      .send({ type: 'note', content: 'Mañana le llamo', occurredAt: '2099-01-01T10:00:00Z' });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('activity_in_future');

    // Liberación: sin actividad desde hace 90 días, pero con un seguimiento en
    // la semana que viene, sigue siendo suyo; sin él, queda libre.
    const old = new Date(Date.now() - 120 * 86_400_000);
    await db.platformLead.update({ where: { id: leadId }, data: { salesAssignedAt: old } });
    await db.platformLeadActivity.updateMany({ where: { leadId }, data: { occurredAt: old } });
    await db.salesAccountProfile.updateMany({ where: { leadId }, data: { lastContactAt: old } });
    await app.get(SalesAssignmentService).releaseStale();
    expect((await db.platformLead.findUniqueOrThrow({ where: { id: leadId } })).salesRepId).toBe(
      repAId,
    );
    await db.platformLeadFollowup.updateMany({ where: { leadId }, data: { status: 'done' } });
    await app.get(SalesAssignmentService).releaseStale();
    expect(
      (await db.platformLead.findUniqueOrThrow({ where: { id: leadId } })).salesRepId,
    ).toBeNull();
  });

  it('un prospecto que se registra sin el código queda pendiente de la dirección', async () => {
    const email = `pendiente-${STAMP}@e2e.local`;
    const created = await http()
      .post('/admin/sales/leads')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ companyName: 'Pendiente SL', email });
    const leadId = created.body.lead.id as string;
    const reg = await register(app, 'salespend', undefined, 'link', email);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: reg.tenantId } });
    expect(tenant.salesRepId).toBeNull();
    const account = await http()
      .get(`/admin/sales/accounts/${leadId}`)
      .set('Authorization', `Bearer ${repAToken}`);
    expect(account.body.pendingAssignment).toBe(true);
    expect(account.body.client).toBeNull();
    const pending = await http()
      .get('/admin/sales-team/pending-assignments')
      .set('Authorization', `Bearer ${superToken}`);
    expect(pending.body.some((p: { tenantId: string }) => p.tenantId === reg.tenantId)).toBe(true);
    // La dirección se la da: ya es suya.
    await http()
      .post('/admin/sales-team/assign')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ tenantId: reg.tenantId, repId: repAId })
      .expect(200);
    const after = await http()
      .get(`/admin/sales/accounts/${leadId}`)
      .set('Authorization', `Bearer ${repAToken}`);
    expect(after.body.pendingAssignment).toBe(false);
    const history = await http()
      .get(`/admin/sales-team/accounts?tenantId=${reg.tenantId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(history.body.repId).toBe(repAId);
    expect(history.body.history[0].source).toBe('Asignada por la dirección');
  });

  it('vender: topes de prueba y cupones, aprobación y propuesta con seguimiento', async () => {
    const ext = await http()
      .post(`/admin/sales/clients/${paidTenantId}/extend-trial`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ days: 10, reason: 'Está migrando sus datos' });
    expect(ext.status).toBe(201);
    const over = await http()
      .post(`/admin/sales/clients/${paidTenantId}/extend-trial`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ days: 10, reason: 'Un poco más' });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('trial_extension_limit');
    expect(over.body.details.remaining).toBe(4);

    // Lo que pasa del tope se pide a la dirección y le avisa al decidir.
    const ask = await http()
      .post('/admin/sales/approvals')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({
        tenantId: paidTenantId,
        reason: 'Necesita una semana más para migrar',
        request: { action: 'extend_trial', payload: { days: 7, reason: 'Migración' } },
      });
    expect(ask.status).toBe(201);
    await http()
      .post(`/admin/approvals/${ask.body.id}/approve`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({})
      .expect((r) => expect([200, 201]).toContain(r.status));
    const mineAsk = await http()
      .get('/admin/sales/approvals')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(mineAsk.body[0].status).toBe('approved');
    const feed = await http()
      .get('/admin/sales/notifications')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(feed.body.items.some((n: { type: string }) => n.type === 'sales.approval_decided')).toBe(
      true,
    );

    // Cupones: solo los marcados para comerciales.
    const badCoupon = await http()
      .post('/admin/sales/quote')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ planId: starterPlanId, couponCode: couponNo });
    expect(badCoupon.status).toBe(403);
    expect(badCoupon.body.code).toBe('coupon_not_allowed');
    const catalog = await http()
      .get('/admin/sales/catalog')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(catalog.body.coupons.map((c: { code: string }) => c.code)).toContain(couponOk);

    // Propuesta a un prospecto: caduca a los 15 días y se sabe cuándo la abre.
    const p = await http()
      .post('/admin/sales/leads')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ companyName: 'Propuesta SL', email: `propuesta-${STAMP}@e2e.local` });
    const sent = await http()
      .post(`/admin/sales/accounts/${p.body.lead.id}/quote`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ planId: starterPlanId, couponCode: couponOk, followupDays: 3 });
    expect(sent.status).toBe(201);
    const offer = sent.body.lead.quoteOffers[0];
    expect(offer.expiresAt).toBeTruthy();
    expect(offer.acceptUrl).toContain(`team=${repACode}`);
    const tracked = app.get(AdminQuoteService).trackedUrl(offer.id);
    const path = new URL(tracked).pathname + new URL(tracked).search;
    const wrong = await http().get(`/v1/public/offers/${offer.id}/open?sig=nope`);
    expect(wrong.status).toBe(302);
    expect(
      (await db.platformQuoteOffer.findUniqueOrThrow({ where: { id: offer.id } })).openedAt,
    ).toBeNull();
    const opened = await http().get(path);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toContain(`team=${repACode}`);
    expect(
      (await db.platformQuoteOffer.findUniqueOrThrow({ where: { id: offer.id } })).openedAt,
    ).not.toBeNull();
    const offers = await http()
      .get('/admin/sales/offers')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(offers.body.find((o: { id: string }) => o.id === offer.id).openedAt).toBeTruthy();
  });

  it('comisiones: % de lo cobrado, fijo por venta, extras aprobados, devoluciones y liquidación', async () => {
    await http()
      .put(`/admin/sales-team/reps/${repAId}/plan`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ revenuePct: 10, revenueMonths: 12, perSaleAmount: 50, perAddonAmount: 20 })
      .expect(200);
    const concept = await http()
      .post(`/admin/sales-team/reps/${repAId}/concepts`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Migración de datos', amount: 80 });
    const conceptId = concept.body.concepts[0].id as string;

    // Primer pago del cliente: 121 € con IVA = 100 € de base.
    const pay = await http()
      .post(`/admin/tenants/${paidTenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 });
    expect(pay.status).toBe(201);
    await http()
      .post('/admin/sales-team/commissions/recalculate')
      .set('Authorization', `Bearer ${superToken}`)
      .expect(200);
    let view = await http()
      .get('/admin/sales/commissions')
      .set('Authorization', `Bearer ${repAToken}`);
    const revenue = view.body.items.find((i: { kind: string }) => i.kind === 'revenue');
    const sale = view.body.items.find((i: { kind: string }) => i.kind === 'sale');
    expect(revenue.amount).toBeCloseTo(10, 2);
    expect(sale.amount).toBe(50);
    // Otro comercial no ve nada de esto.
    const viewB = await http()
      .get('/admin/sales/commissions')
      .set('Authorization', `Bearer ${repBToken}`);
    expect(viewB.body.items).toHaveLength(0);

    // Segundo cobro, por remesa SEPA (un solo cargo para el plan y sus extras).
    const manualPayment = await db.tenantSubscriptionPayment.findFirstOrThrow({
      where: { tenantId: paidTenantId, status: 'paid' },
      orderBy: { createdAt: 'desc' },
    });
    const sepaPayment = await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: paidTenantId,
        provider: 'sepa',
        status: 'paid',
        amount: 121,
        paidAt: new Date(),
        description: 'Cuota de la suscripción',
      },
    });
    const revenueSum = async () => {
      await http()
        .post('/admin/sales-team/commissions/recalculate')
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);
      const v = await http()
        .get('/admin/sales/commissions')
        .set('Authorization', `Bearer ${repAToken}`);
      return (v.body.items as { kind: string; amount: number }[])
        .filter((i) => i.kind === 'revenue')
        .reduce((s, i) => s + i.amount, 0);
    };
    expect(await revenueSum()).toBeCloseTo(20, 2);

    // Un extra contratado después de la venta espera a la dirección.
    await http()
      .post(`/admin/tenants/${paidTenantId}/addons`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ addonId, quantity: 1 })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const claims = await http()
      .get('/admin/sales/claims')
      .set('Authorization', `Bearer ${repAToken}`);
    const claim = claims.body.find((c: { addonId: string }) => c.addonId === addonId);
    expect(claim.status).toBe('pending');
    expect(claim.partOfSale).toBe(false);
    // Contratarlo después no cambia lo que contaba el cobro anterior.
    expect(await revenueSum()).toBeCloseTo(20, 2);
    await http()
      .put(`/admin/sales/claims/${claim.id}/note`)
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ repNote: 'Se lo propuse yo en la llamada del martes' })
      .expect(200);
    const approved = await http()
      .post(`/admin/sales-team/claims/${claim.id}/approve`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ note: 'De acuerdo' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    view = await http().get('/admin/sales/commissions').set('Authorization', `Bearer ${repAToken}`);
    expect(view.body.items.find((i: { kind: string }) => i.kind === 'addon_sale').amount).toBe(20);

    // Devolución de la mitad del primer cobro, por la vía real (el cobro pasa
    // a «devuelto en parte»): se descuenta del %.
    await app.get(BillingSaasService).syncSubscriptionRefund(manualPayment.id, 60.5);
    expect(
      (await db.tenantSubscriptionPayment.findUniqueOrThrow({ where: { id: manualPayment.id } }))
        .status,
    ).toBe('partially_refunded');
    expect(await revenueSum()).toBeCloseTo(15, 2);

    // Concepto pedido por el comercial: pendiente hasta que se aprueba.
    const asked = await http()
      .post('/admin/sales/commissions/concepts')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ tenantId: paidTenantId, conceptId, note: 'Migración de 300 contratos' });
    expect(asked.body.totals.pending).toBe(80);
    const pendingItem = asked.body.items.find((i: { status: string }) => i.status === 'pending');
    await http()
      .post(`/admin/sales-team/commissions/items/${pendingItem.id}/approve`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({})
      .expect(200);

    // Liquidación del mes: todo lo aprobado y sin liquidar.
    view = await http().get('/admin/sales/commissions').set('Authorization', `Bearer ${repAToken}`);
    const expected = view.body.totals.approvedUnsettled as number;
    expect(expected).toBeCloseTo(15 + 50 + 20 + 80, 2);
    const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
    const settlement = await http()
      .post('/admin/sales-team/settlements')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ repId: repAId, month });
    expect(settlement.status).toBe(201);
    expect(settlement.body.total).toBeCloseTo(expected, 2);
    // Se paga en efectivo: queda pagada al liquidar y no se le avisa.
    expect(settlement.body.status).toBe('paid');
    expect(settlement.body.paidAt).toBeTruthy();
    expect(
      await db.superAdminNotification.count({
        where: { recipientId: repAId, type: 'sales.settlement' },
      }),
    ).toBe(0);
    const twice = await http()
      .post('/admin/sales-team/settlements')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ repId: repAId, month });
    expect(twice.status).toBe(400);
    const mine = await http()
      .get('/admin/sales/settlements')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(mine.body[0].status).toBe('paid');

    // Una partida ya decidida no se vuelve a decidir (se corrige con un ajuste).
    await http()
      .post(`/admin/sales-team/commissions/items/${pendingItem.id}/reject`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({})
      .expect(409);

    // Cambiar la decisión de un extra ya liquidado: descuento y, al volver, reintegro.
    await http()
      .post(`/admin/sales-team/claims/${claim.id}/reject`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ note: 'Me equivoqué' })
      .expect(200);
    const claimSum = async () =>
      Number(
        (
          await db.salesCommissionItem.aggregate({
            where: { claimId: claim.id, status: 'approved' },
            _sum: { amount: true },
          })
        )._sum.amount ?? 0,
      );
    expect(await claimSum()).toBeCloseTo(0, 2);
    await http()
      .post(`/admin/sales-team/claims/${claim.id}/approve`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({})
      .expect(200);
    expect(await claimSum()).toBeCloseTo(20, 2);

    // Todo devuelto el cobro SEPA: su % se descuenta entero.
    await app.get(BillingSaasService).syncSubscriptionRefund(sepaPayment.id, 121);
    expect(await revenueSum()).toBeCloseTo(5, 2);

    // El equipo lo resume.
    const team = await http().get('/admin/sales-team').set('Authorization', `Bearer ${superToken}`);
    const a = team.body.reps.find((r: { id: string }) => r.id === repAId);
    expect(a.customers).toBeGreaterThanOrEqual(1);
    expect(a.newClientsMonth).toBeGreaterThanOrEqual(1);
  });

  it('la cuenta de demostración se crea, se reinicia y la abre un comercial', async () => {
    const created = await http()
      .post('/admin/sales-team/demo')
      .set('Authorization', `Bearer ${superToken}`);
    expect(created.status).toBe(201);
    const demoId = created.body.demo.tenantId as string;
    try {
      const contracts = await db.contract.count({ where: { tenantId: demoId, status: 'active' } });
      expect(contracts).toBeGreaterThan(10);
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: demoId } });
      expect(tenant.billingExempt).toBe(true);
      // Un poco de todo para enseñar.
      const inv = (status: 'paid' | 'overdue' | 'issued') =>
        db.invoice.count({ where: { tenantId: demoId, kind: 'invoice', status } });
      expect(await inv('paid')).toBeGreaterThan(20);
      expect((await inv('overdue')) + (await inv('issued'))).toBeGreaterThan(0);
      expect(
        await db.invoice.count({ where: { tenantId: demoId, kind: 'deposit_receipt' } }),
      ).toBeGreaterThan(5);
      expect(
        await db.payment.count({ where: { tenantId: demoId, status: 'succeeded' } }),
      ).toBeGreaterThan(20);
      expect(
        await db.contract.count({
          where: { tenantId: demoId, status: { in: ['ended', 'draft'] } },
        }),
      ).toBeGreaterThanOrEqual(8);
      const demoLeads = { tenantId: demoId, metadata: { path: ['demo'], equals: true } };
      expect(await db.lead.count({ where: demoLeads })).toBeGreaterThanOrEqual(10);
      expect(await db.task.count({ where: { tenantId: demoId } })).toBe(7);
      expect(await db.incident.count({ where: { tenantId: demoId } })).toBe(4);
      expect(await db.expense.count({ where: { tenantId: demoId } })).toBeGreaterThan(20);
      expect(await db.accessLog.count({ where: { tenantId: demoId } })).toBeGreaterThan(20);
      expect(await db.review.count({ where: { tenantId: demoId } })).toBeGreaterThan(3);
      expect(await db.competitorFacility.count({ where: { tenantId: demoId } })).toBe(2);
      expect(await db.reservation.count({ where: { tenantId: demoId } })).toBe(2);
      expect(await db.waitlistEntry.count({ where: { tenantId: demoId } })).toBe(3);
      // La serie sigue desde la última factura.
      const series = await db.invoiceSeries.findFirstOrThrow({
        where: { tenantId: demoId, isDefault: true },
      });
      const year = new Date().getUTCFullYear();
      const lastNumber = await db.invoice.count({
        where: {
          tenantId: demoId,
          kind: 'invoice',
          issueDate: { gte: new Date(Date.UTC(year, 0, 1)) },
        },
      });
      expect(series.nextNumber).toBe(lastNumber + 1);
      // A los inquilinos de la demo no se les escribe.
      const customer = await db.customer.findFirstOrThrow({
        where: { tenantId: demoId, email: { not: null } },
      });
      const comm = await db.communication.create({
        data: {
          tenantId: demoId,
          customerId: customer.id,
          channel: 'email',
          recipient: customer.email!,
          subject: 'Prueba',
          bodyText: 'Prueba',
        },
      });
      await app.get(CommunicationsService).dispatch(demoId, comm.id);
      expect((await db.communication.findUniqueOrThrow({ where: { id: comm.id } })).status).toBe(
        'skipped',
      );
      // Lo que el comercial toque de la estructura vuelve con el reinicio.
      await db.unitType.updateMany({
        where: { tenantId: demoId, name: 'Taquilla' },
        data: { defaultPriceMonthly: 999 },
      });
      const facility = await db.facility.findFirstOrThrow({ where: { tenantId: demoId } });
      await db.facility.update({ where: { id: facility.id }, data: { deletedAt: new Date() } });
      // Un reinicio a la vez.
      await db.platformSalesSettings.updateMany({ data: { demoResettingAt: new Date() } });
      const busy = await http()
        .post('/admin/sales-team/demo/reset')
        .set('Authorization', `Bearer ${superToken}`);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('demo_resetting');
      await db.platformSalesSettings.updateMany({ data: { demoResettingAt: null } });
      const reset = await http()
        .post('/admin/sales-team/demo/reset')
        .set('Authorization', `Bearer ${superToken}`);
      expect(reset.status).toBe(200);
      expect(
        await db.contract.count({ where: { tenantId: demoId, status: 'active' } }),
      ).toBeGreaterThan(10);
      // El reinicio no duplica lo que se conserva (contactos y competencia).
      expect(await db.lead.count({ where: demoLeads })).toBeLessThanOrEqual(12);
      expect(await db.competitorFacility.count({ where: { tenantId: demoId } })).toBe(2);
      expect(await db.task.count({ where: { tenantId: demoId } })).toBe(7);
      expect(
        Number(
          (await db.unitType.findFirstOrThrow({ where: { tenantId: demoId, name: 'Taquilla' } }))
            .defaultPriceMonthly,
        ),
      ).toBe(29);
      expect(
        (await db.facility.findUniqueOrThrow({ where: { id: facility.id } })).deletedAt,
      ).toBeNull();
      const open = await http()
        .post('/admin/sales/demo/open')
        .set('Authorization', `Bearer ${repAToken}`);
      expect(open.status).toBe(200);
      expect(open.body.accessToken).toBeTruthy();
      expect(open.body.readOnly).toBe(false);
      // El comercial entra al área de clientes como la inquilina de la demo.
      const status = await http()
        .get('/admin/sales/demo')
        .set('Authorization', `Bearer ${repAToken}`);
      expect(status.body.tenantSlug).toBeTruthy();
      const portal = await http()
        .post('/admin/sales/demo/portal')
        .set('Authorization', `Bearer ${repAToken}`);
      expect(portal.status).toBe(200);
      expect(portal.body.customerName).toBe('Laura Martín Sanz');
      const token = new URL(portal.body.url as string).searchParams.get('token');
      const session = await http().post('/portal/login/consume').send({ token }).expect(200);
      const portalAuth = { Authorization: `Bearer ${session.body.accessToken}` };
      const access = await http().get('/portal/me/access').set(portalAuth);
      expect(access.status).toBe(200);
      expect(JSON.stringify(access.body)).toContain('482913');
      // Lo que escribe le llega al negocio de la demo.
      await http()
        .post('/portal/me/messages')
        .set(portalAuth)
        .send({ body: 'Hola, quiero un trastero más grande' })
        .expect(201);
      expect(
        await db.customerMessage.count({
          where: {
            tenantId: demoId,
            customerId: session.body.customerId,
            body: 'Hola, quiero un trastero más grande',
          },
        }),
      ).toBe(1);
      // El contacto que ve el cliente no es el correo de quien creó la demo.
      expect((await db.tenant.findUniqueOrThrow({ where: { id: demoId } })).contactEmail).toBe(
        'hola@example.com',
      );
      // Su web pública está publicada.
      await http().get(`/public/landing/${status.body.tenantSlug}`).expect(200);
      // Las facturas se ven en el panel de la demo.
      const invoices = await http()
        .get('/invoices?status=overdue')
        .set('Authorization', `Bearer ${open.body.accessToken}`);
      expect(invoices.status).toBe(200);
    } finally {
      await db.platformSalesSettings.updateMany({ data: { demoTenantId: null } });
      await db.tenant.update({ where: { id: demoId }, data: { slug: `test-sales-demo-${STAMP}` } });
    }
  });

  it('un lead creado en el admin y asignado a un comercial sale en su panel', async () => {
    const created = await http()
      .post('/admin/leads')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        companyName: 'Trasteros del Admin',
        phone: `6${String(Date.now()).slice(-8)}`,
        source: 'phone',
        assignedToId: repAId,
      })
      .expect(201);
    const leadId = created.body.id as string;
    const listOf = async (token: string) =>
      (
        await http().get('/admin/sales/leads').set('Authorization', `Bearer ${token}`).expect(200)
      ).body.items.map((l: { id: string }) => l.id) as string[];
    expect(await listOf(repAToken)).toContain(leadId);

    // Reasignado desde el admin a otro comercial: cambia de cartera.
    await http()
      .patch(`/admin/leads/${leadId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ assignedToId: repBId })
      .expect(200);
    expect(await listOf(repBToken)).toContain(leadId);
    expect(await listOf(repAToken)).not.toContain(leadId);
  });

  it('un comercial solo se gestiona en «Equipo comercial» y no puede quitarse la 2FA', async () => {
    const viaSuperAdmins = await http()
      .post('/admin/super-admins')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ email: `otro-${STAMP}@storageos.local`, fullName: 'Otro Comercial', role: 'sales' });
    expect(viaSuperAdmins.status).toBe(400);
    expect(viaSuperAdmins.body.code).toBe('sales_role_locked');
    const toSupport = await http()
      .patch(`/admin/super-admins/${repBId}/role`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ role: 'support' });
    expect(toSupport.status).toBe(400);
    expect(toSupport.body.code).toBe('sales_role_locked');

    const status = await http()
      .get('/admin/auth/2fa/status')
      .set('Authorization', `Bearer ${repBToken}`);
    expect(status.body).toMatchObject({ required: true, deadline: null });
    // Con 2FA activa en la base de datos, desactivarla no se permite (la contraseña es correcta).
    await db.superAdmin.update({
      where: { id: repBId },
      data: { twoFactorSecretEncrypted: 'x' },
    });
    const disable = await http()
      .post('/admin/auth/2fa/disable')
      .set('Authorization', `Bearer ${repBToken}`)
      .send({ password: PASSWORD });
    expect(disable.status).toBe(400);
    expect(disable.body.code).toBe('two_factor_required_by_policy');
    await db.superAdmin.update({ where: { id: repBId }, data: { twoFactorSecretEncrypted: null } });
  });

  it('la dirección puede quitarle a un comercial la verificación en dos pasos', async () => {
    await db.superAdmin.update({ where: { id: repBId }, data: { twoFactorEnabled: false } });
    const blocked = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repBToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('admin_two_factor_required');

    const off = await http()
      .patch(`/admin/sales-team/reps/${repBId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ twoFactorRequired: false });
    expect(off.status).toBe(200);
    expect(off.body.twoFactorRequired).toBe(false);
    const ok = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repBToken}`);
    expect(ok.status).toBe(200);
    const status = await http()
      .get('/admin/auth/2fa/status')
      .set('Authorization', `Bearer ${repBToken}`);
    expect(status.body).toMatchObject({ required: false, deadline: null });
    // Un comercial no puede quitársela a sí mismo.
    const self = await http()
      .patch(`/admin/sales-team/reps/${repBId}`)
      .set('Authorization', `Bearer ${repBToken}`)
      .send({ twoFactorRequired: false });
    expect(self.status).toBe(403);

    const on = await http()
      .patch(`/admin/sales-team/reps/${repBId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ twoFactorRequired: true });
    expect(on.body.twoFactorRequired).toBe(true);
    const again = await http().get('/admin/sales/me').set('Authorization', `Bearer ${repBToken}`);
    expect(again.status).toBe(403);
    await db.superAdmin.update({ where: { id: repBId }, data: { twoFactorEnabled: true } });
  });

  it('materiales y plantillas: los prepara la dirección y los lee el comercial', async () => {
    const note = await http()
      .post('/admin/sales-team/materials')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        title: `Guion de llamada ${STAMP}`,
        kind: 'note',
        body: '1. Saluda. 2. Pregunta cuántos trasteros tiene.',
      });
    expect(note.status).toBe(201);
    const list = await http()
      .get('/admin/sales/materials')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(list.body.some((m: { id: string }) => m.id === note.body.id)).toBe(true);
    const forbidden = await http()
      .post('/admin/sales-team/materials')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ title: 'No', kind: 'note', body: 'x' });
    expect(forbidden.status).toBe(403);
    const templates = await http()
      .get('/admin/sales/templates')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(templates.body.length).toBeGreaterThan(0);
    await http()
      .delete(`/admin/sales-team/materials/${note.body.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .expect(204);
  });

  it('garantía de la venta, tramos y bonus al cerrar el mes, «recibido», previsión y comparativa', async () => {
    const asSuper = { Authorization: `Bearer ${superToken}` };
    const asA = { Authorization: `Bearer ${repAToken}` };
    const asB = { Authorization: `Bearer ${repBToken}` };
    const recalc = () =>
      http().post('/admin/sales-team/commissions/recalculate').set(asSuper).expect(200);

    // Garantía: si se va antes de 6 meses, el fijo de la venta (ya liquidado) se descuenta.
    const plan = await http().put(`/admin/sales-team/reps/${repAId}/plan`).set(asSuper).send({
      revenuePct: 10,
      revenueMonths: 12,
      perSaleAmount: 50,
      perAddonAmount: 20,
      guaranteeMonths: 6,
    });
    expect(plan.status).toBe(200);
    expect(plan.body.guaranteeMonths).toBe(6);
    const saleSum = async () => {
      const sale = await db.salesCommissionItem.findFirstOrThrow({
        where: { tenantId: paidTenantId, kind: 'sale' },
      });
      const agg = await db.salesCommissionItem.aggregate({
        where: { status: 'approved', OR: [{ id: sale.id }, { relatedItemId: sale.id }] },
        _sum: { amount: true },
      });
      return Number(agg._sum.amount ?? 0);
    };
    expect(await saleSum()).toBeCloseTo(50, 2);
    await db.tenant.update({
      where: { id: paidTenantId },
      data: { status: 'cancelled', canceledAt: new Date() },
    });
    await recalc();
    expect(await saleSum()).toBeCloseTo(0, 2);
    // Vuelve: el fijo se reintegra.
    await db.tenant.update({
      where: { id: paidTenantId },
      data: { status: 'active', canceledAt: null },
    });
    await recalc();
    expect(await saleSum()).toBeCloseTo(50, 2);

    // Tramos y bonus de Beto en el mes pasado.
    const prev = new Date(
      `${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7)}-15T12:00:00Z`,
    );
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const prevMonth = prev.toISOString().slice(0, 7);
    await http()
      .put(`/admin/sales-team/reps/${repBId}/plan`)
      .set(asSuper)
      .send({
        revenuePct: 0,
        revenueMonths: null,
        perSaleAmount: 50,
        perAddonAmount: 0,
        saleTiers: [{ fromSales: 2, amount: 80 }],
        targetBonus: 100,
      })
      .expect(200);
    await http()
      .put(`/admin/sales-team/reps/${repBId}/targets`)
      .set(asSuper)
      .send({ month: prevMonth, newClients: 1, newMrr: 50 })
      .expect(200);
    const t1 = await register(app, 'salestier1');
    const t2 = await register(app, 'salestier2');
    for (const t of [t1, t2]) {
      await db.salesCommissionItem.create({
        data: {
          repId: repBId,
          tenantId: t.tenantId,
          kind: 'sale',
          description: 'Venta',
          month: prevMonth,
          amount: 50,
          status: 'approved',
        },
      });
    }
    await db.salesWin.create({
      data: { tenantId: t1.tenantId, repId: repBId, month: prevMonth, paidAt: prev, monthly: 79 },
    });
    const closed = await http()
      .post('/admin/sales-team/commissions/close-month')
      .set(asSuper)
      .send({ month: prevMonth });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ tiers: 1, bonuses: 1 });
    const again = await http()
      .post('/admin/sales-team/commissions/close-month')
      .set(asSuper)
      .send({ month: prevMonth });
    expect(again.body).toEqual({ tiers: 0, bonuses: 0 });
    const thisMonth = new Date()
      .toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
      .slice(0, 7);
    await http()
      .post('/admin/sales-team/commissions/close-month')
      .set(asSuper)
      .send({ month: thisMonth })
      .expect(400);
    const bView = await http().get('/admin/sales/commissions').set(asB);
    const tier = bView.body.items.find((i: { kind: string }) => i.kind === 'tier');
    const bonus = bView.body.items.find((i: { kind: string }) => i.kind === 'bonus');
    expect(tier.amount).toBe(60);
    expect(tier.tenantId).toBeNull();
    expect(bonus.amount).toBe(100);

    // Liquidación en efectivo: Beto confirma que la ha recibido (una vez); Ana no puede.
    const settlement = await http()
      .post('/admin/sales-team/settlements')
      .set(asSuper)
      .send({ repId: repBId, month: prevMonth });
    expect(settlement.status).toBe(201);
    expect(settlement.body.receivedAt).toBeNull();
    await http()
      .post(`/admin/sales/settlements/${settlement.body.id}/received`)
      .set(asA)
      .send({})
      .expect(404);
    const got = await http()
      .post(`/admin/sales/settlements/${settlement.body.id}/received`)
      .set(asB)
      .send({ note: 'Recibido en mano' });
    expect(got.status).toBe(200);
    expect(got.body.receivedAt).toBeTruthy();
    expect(got.body.receivedNote).toBe('Recibido en mano');
    await http()
      .post(`/admin/sales/settlements/${settlement.body.id}/received`)
      .set(asB)
      .send({})
      .expect(409);
    // El justificante de otro comercial no se puede pedir.
    await http().get(`/admin/sales/settlements/${settlement.body.id}/receipt`).set(asA).expect(404);

    // Previsión del comercial y del equipo, y comparativa.
    const forecast = await http().get('/admin/sales/forecast').set(asA);
    expect(forecast.status).toBe(200);
    expect(forecast.body.months).toHaveLength(6);
    expect(forecast.body.revenuePct).toBe(10);
    expect(forecast.body.clients).toBeGreaterThanOrEqual(1);
    const team = await http().get('/admin/sales-team/forecast').set(asSuper);
    expect(team.status).toBe(200);
    expect(team.body.reps.some((r: { repId: string }) => r.repId === repAId)).toBe(true);
    const comparison = await http().get('/admin/sales-team/comparison?months=3').set(asSuper);
    expect(comparison.status).toBe(200);
    const a = comparison.body.rows.find((r: { repId: string }) => r.repId === repAId);
    expect(a.wins).toBeGreaterThanOrEqual(1);
    expect(a.mrr).toBeGreaterThan(0);
    // Un comercial no ve la comparativa del equipo.
    await http().get('/admin/sales-team/comparison').set(asA).expect(403);
  });
});
