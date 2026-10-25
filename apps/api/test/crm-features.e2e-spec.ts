import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { WinbackService } from '../src/modules/campaigns/winback.service';
import { LeadCrmService } from '../src/modules/leads/lead-crm.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Funcionalidades del CRM: seguimientos y actividad de contactos, reparto y
 * aviso de los sin atender, tiempos de respuesta, duplicados, resultados de
 * campañas con clics, plantillas, win-back en dos pasos y reseña en Google.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

describe('Funcionalidades del CRM (e2e)', () => {
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

  it('seguimientos, actividad, reparto, sin atender y tiempos de respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'crmfa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Reparto por turnos: el único usuario recibe los contactos nuevos.
    await http()
      .put('/leads/settings')
      .set(auth)
      .send({ autoAssign: 'round_robin', responseHours: 2 })
      .expect(200);
    const lead = await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Pablo',
        email: `pablo-${Date.now()}@e2e.local`,
        phone: '600 123 456',
        hp: '',
        acceptsTerms: true,
      });
    expect(lead.status).toBe(201);
    let assigned: string | null = null;
    for (let i = 0; i < 20 && !assigned; i++) {
      assigned =
        (await db.lead.findUnique({ where: { id: lead.body.id } }))?.assignedToUserId ?? null;
      if (!assigned) await sleep(200);
    }
    expect(assigned).toBe(owner.userId);

    // Seguimiento para hoy: sale en la bandeja y en «Hoy».
    const fu = await http()
      .post(`/leads/${lead.body.id}/followups`)
      .set(auth)
      .send({ title: 'Volver a llamar', dueDate: today() });
    expect(fu.status).toBe(201);
    const pending = await http().get('/leads/followups/pending').set(auth).expect(200);
    expect(pending.body.map((f: { id: string }) => f.id)).toContain(fu.body.id);
    const todayView = await http().get('/dashboard/today').set(auth).expect(200);
    expect(todayView.body.leadFollowupsDue.count).toBe(1);

    // Sin atender pasado el plazo: un aviso, una sola vez.
    await db.lead.update({
      where: { id: lead.body.id },
      data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
    });
    const crm = app.get(LeadCrmService);
    expect(await crm.notifyUnattended()).toBeGreaterThanOrEqual(1);
    expect(
      await db.notification.count({ where: { tenantId: owner.tenantId, type: 'lead.unattended' } }),
    ).toBe(1);
    await crm.notifyUnattended();
    expect(
      await db.notification.count({ where: { tenantId: owner.tenantId, type: 'lead.unattended' } }),
    ).toBe(1);
    const unattended = await http().get('/dashboard/today').set(auth).expect(200);
    expect(unattended.body.unattendedLeads.count).toBe(1);

    // Anotar una llamada lo da por atendido.
    const call = await http()
      .post(`/leads/${lead.body.id}/activities`)
      .set(auth)
      .send({ type: 'call', content: 'Le interesa el de 5 m²' });
    expect(call.status).toBe(201);
    const after = await http().get(`/leads/${lead.body.id}`).set(auth).expect(200);
    expect(after.body.status).toBe('contacted');
    expect(after.body.score).toBeGreaterThan(0);
    const acts = await http().get(`/leads/${lead.body.id}/activities`).set(auth).expect(200);
    expect(acts.body).toHaveLength(1);

    const stats = await http().get('/leads/response-stats?days=30').set(auth).expect(200);
    expect(stats.body.overall.contacted).toBe(1);
    expect(stats.body.overall.medianHours).toBeGreaterThanOrEqual(2.9);
    expect(stats.body.unattended).toBe(0);
  });

  it('duplicados: fusionar contactos y enlazar con el inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'crmdup');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `dup-${Date.now()}@e2e.local`;
    const a = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Eva', email, source: 'idealista', message: 'Primer mensaje' })
      .expect(201);
    const b = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Eva', email, phone: '611222333', source: 'llamada', message: 'Segundo' })
      .expect(201);
    await http()
      .post(`/leads/${b.body.id}/activities`)
      .set(auth)
      .send({ type: 'note', content: 'nota del repetido' })
      .expect(201);

    const groups = await http().get('/leads/duplicates').set(auth).expect(200);
    const group = groups.body.find((g: { key: string }) => g.key === email);
    expect(group.leads.map((l: { id: string }) => l.id)).toEqual([a.body.id, b.body.id]);

    await http()
      .post(`/leads/${b.body.id}/merge`)
      .set(auth)
      .send({ intoLeadId: a.body.id })
      .expect(204);
    const merged = await http().get(`/leads/${a.body.id}`).set(auth).expect(200);
    expect(merged.body.phone).toBe('611222333');
    expect(merged.body.message).toContain('Segundo');
    const acts = await http().get(`/leads/${a.body.id}/activities`).set(auth).expect(200);
    expect(acts.body).toHaveLength(1);
    await http().get(`/leads/${b.body.id}`).set(auth).expect(404);

    // Un contacto que ya es inquilino (mismo teléfono) se enlaza.
    const customerId = await createCustomer(app, owner.accessToken);
    await db.customer.update({ where: { id: customerId }, data: { phone: '+34 622 333 444' } });
    const c = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Iván', phone: '622333444', source: 'manual' })
      .expect(201);
    const withCustomer = await http().get('/leads/duplicates').set(auth).expect(200);
    expect(
      withCustomer.body.find((g: { key: string }) => g.key === '622333444')?.customer?.id,
    ).toBe(customerId);
    await http()
      .post(`/leads/${c.body.id}/link-customer`)
      .set(auth)
      .send({ customerId })
      .expect(204);
    const linked = await http().get(`/leads/${c.body.id}`).set(auth).expect(200);
    expect(linked.body).toMatchObject({ status: 'won', convertedCustomerId: customerId });
  });

  it('campañas: clics con seguimiento, resultados, plantillas y vista previa', async () => {
    const owner = await registerVerifiedUser(app, 'crmcmp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createCustomer(app, owner.accessToken);

    const tpl = await http()
      .post('/campaigns/templates')
      .set(auth)
      .send({
        name: 'Oferta',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Mira https://example.com/oferta.',
      })
      .expect(201);
    const list = await http().get('/campaigns/templates').set(auth).expect(200);
    expect(list.body.map((t: { id: string }) => t.id)).toContain(tpl.body.id);
    const preview = await http()
      .post('/campaigns/preview-email')
      .set(auth)
      .send({ subject: tpl.body.subject, bodyText: tpl.body.bodyText })
      .expect(200);
    expect(preview.body.subject).toBe('Hola Lucía');
    expect(preview.body.html).toContain('https://example.com/oferta');

    const campaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Con enlace',
        subject: tpl.body.subject,
        bodyText: tpl.body.bodyText,
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    await http().post(`/campaigns/${campaign.body.id}/send`).set(auth).expect(200);
    let comm: { bodyText: string | null } | null = null;
    for (let i = 0; i < 30 && !comm; i++) {
      comm = await db.communication.findFirst({
        where: { source: `campaign:${campaign.body.id}` },
      });
      if (!comm) await sleep(200);
    }
    const token = comm?.bodyText?.match(/campaign-click\/([^\s.]+\.[^\s.]+\.[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(comm?.bodyText).not.toContain('https://example.com/oferta');

    const click = await http().get(`/v1/public/campaign-click/${token}`).redirects(0);
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe('https://example.com/oferta');
    await http().get(`/v1/public/campaign-click/${token}`).redirects(0).expect(302);
    const bad = await http().get('/v1/public/campaign-click/no-vale').redirects(0);
    expect(bad.status).toBe(302);
    expect(bad.headers.location).not.toContain('example.com');

    const results = await http()
      .get(`/campaigns/${campaign.body.id}/results`)
      .set(auth)
      .expect(200);
    expect(results.body).toMatchObject({ recipients: 1, clickers: 1 });
    expect(results.body.links).toEqual([{ url: 'https://example.com/oferta', clicks: 1 }]);

    await http().delete(`/campaigns/templates/${tpl.body.id}`).set(auth).expect(204);
  });

  it('win-back en dos pasos con cupón y recuperados', async () => {
    const owner = await registerVerifiedUser(app, 'crmwb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    await http().post(`/contracts/${contract.body.id}/end`).set(auth).send({}).expect(200);

    // Un cupón solo para clientes nuevos no vale para un ex-cliente.
    await http()
      .post('/coupons')
      .set(auth)
      .send({
        code: 'NUEVOS',
        name: 'Nuevos',
        discountType: 'percentage',
        discountValue: 10,
        newCustomersOnly: true,
      })
      .expect(201);
    const badCoupon = await http()
      .patch('/campaigns/winback-settings')
      .set(auth)
      .send({ secondCouponCode: 'NUEVOS' });
    expect(badCoupon.status).toBe(400);
    expect(badCoupon.body.code).toBe('coupon_new_customers_only');
    await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'VUELVE', name: 'Vuelve', discountType: 'percentage', discountValue: 20 })
      .expect(201);
    await http()
      .patch('/campaigns/winback-settings')
      .set(auth)
      .send({ enabled: true, secondEnabled: true, secondDelayDays: 30, secondCouponCode: 'vuelve' })
      .expect(200);

    // El primer aviso se mandó hace 40 días.
    await db.winbackSend.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        step: 1,
        sentAt: new Date(Date.now() - 40 * DAY),
      },
    });
    const run = await app.get(WinbackService).runForTenant(owner.tenantId);
    expect(run.secondSent).toBe(1);
    const second = await db.communication.findFirst({
      where: { tenantId: owner.tenantId, source: 'winback.second' },
    });
    expect(second?.bodyText).toContain('VUELVE');
    expect((await app.get(WinbackService).runForTenant(owner.tenantId)).secondSent).toBe(0);

    // Su contrato antiguo se firmó antes del aviso: aún no ha vuelto.
    await db.contract.update({
      where: { id: contract.body.id },
      data: { signedAt: new Date(Date.now() - 200 * DAY) },
    });
    const stats = await http().get('/campaigns/winback/stats').set(auth).expect(200);
    expect(stats.body).toMatchObject({ firstSent: 1, secondSent: 1, recovered: 0 });

    // Vuelve a firmar: cuenta como recuperado.
    const again = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-11-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await http().post(`/contracts/${again.body.id}/sign`).set(auth).send({}).expect(200);
    const back = await http().get('/campaigns/winback/stats').set(auth).expect(200);
    expect(back.body).toMatchObject({ recovered: 1, recoveryRate: 100 });
  });

  it('pedir la reseña en Google a una valoración publicada', async () => {
    const owner = await registerVerifiedUser(app, 'crmgoo');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const req = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, channel: 'email' })
      .expect(201);
    const token = req.body.reviewUrl.split('/').pop();
    await http()
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 10, comment: 'Todo perfecto' })
      .expect(201);

    // Sin publicar ni enlace de Google: no se puede.
    await http().post(`/reviews/${req.body.id}/google-request`).set(auth).expect(400);
    await http()
      .patch(`/reviews/${req.body.id}/web`)
      .set(auth)
      .send({ published: true })
      .expect(200);
    const noUrl = await http().post(`/reviews/${req.body.id}/google-request`).set(auth);
    expect(noUrl.body.code).toBe('google_review_url_missing');
    await http()
      .patch('/settings/tenant/reviews')
      .set(auth)
      .send({ googleReviewUrl: 'https://g.page/r/mock/review' })
      .expect(200);

    const ok = await http().post(`/reviews/${req.body.id}/google-request`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.googleRequestedAt).not.toBeNull();
    const mail = await db.communication.findFirst({
      where: { tenantId: owner.tenantId, source: 'reviews.google' },
    });
    expect(mail?.bodyText).toContain('https://g.page/r/mock/review');
    await http().post(`/reviews/${req.body.id}/google-request`).set(auth).expect(409);
  });
});
