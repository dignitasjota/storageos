import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminQuoteService } from '../src/modules/admin/admin-quote.service';

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
    expect(ok.body.signupUrl).toContain(`comercial=${ok.body.salesCode}`);
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
    expect(offer.acceptUrl).toContain(`comercial=${repACode}`);
    const tracked = app.get(AdminQuoteService).trackedUrl(offer.id);
    const path = new URL(tracked).pathname + new URL(tracked).search;
    const wrong = await http().get(`/v1/public/offers/${offer.id}/open?sig=nope`);
    expect(wrong.status).toBe(302);
    expect(
      (await db.platformQuoteOffer.findUniqueOrThrow({ where: { id: offer.id } })).openedAt,
    ).toBeNull();
    const opened = await http().get(path);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toContain(`comercial=${repACode}`);
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

    // Devolución de la mitad: se descuenta del %.
    const payment = await db.tenantSubscriptionPayment.findFirstOrThrow({
      where: { tenantId: paidTenantId, status: 'paid' },
      orderBy: { createdAt: 'desc' },
    });
    await db.tenantSubscriptionPayment.update({
      where: { id: payment.id },
      data: { refundedAmount: 60.5, refundedAt: new Date() },
    });
    await http()
      .post('/admin/sales-team/commissions/recalculate')
      .set('Authorization', `Bearer ${superToken}`)
      .expect(200);
    view = await http().get('/admin/sales/commissions').set('Authorization', `Bearer ${repAToken}`);
    const revenueTotal = view.body.items
      .filter((i: { kind: string }) => i.kind === 'revenue')
      .reduce((s: number, i: { amount: number }) => s + i.amount, 0);
    expect(revenueTotal).toBeCloseTo(5, 2);

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
    expect(expected).toBeCloseTo(5 + 50 + 20 + 80, 2);
    const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
    const settlement = await http()
      .post('/admin/sales-team/settlements')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ repId: repAId, month });
    expect(settlement.status).toBe(201);
    expect(settlement.body.total).toBeCloseTo(expected, 2);
    const twice = await http()
      .post('/admin/sales-team/settlements')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ repId: repAId, month });
    expect(twice.status).toBe(400);
    await http()
      .post(`/admin/sales-team/settlements/${settlement.body.id}/paid`)
      .set('Authorization', `Bearer ${superToken}`)
      .expect(200);
    const mine = await http()
      .get('/admin/sales/settlements')
      .set('Authorization', `Bearer ${repAToken}`);
    expect(mine.body[0].status).toBe('paid');

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
      const reset = await http()
        .post('/admin/sales-team/demo/reset')
        .set('Authorization', `Bearer ${superToken}`);
      expect(reset.status).toBe(200);
      expect(
        await db.contract.count({ where: { tenantId: demoId, status: 'active' } }),
      ).toBeGreaterThan(10);
      const open = await http()
        .post('/admin/sales/demo/open')
        .set('Authorization', `Bearer ${repAToken}`);
      expect(open.status).toBe(200);
      expect(open.body.accessToken).toBeTruthy();
      expect(open.body.readOnly).toBe(false);
    } finally {
      await db.platformSalesSettings.updateMany({ data: { demoTenantId: null } });
      await db.tenant.update({ where: { id: demoId }, data: { slug: `test-sales-demo-${STAMP}` } });
    }
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
});
