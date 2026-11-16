import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CampaignAutomationsService } from '../src/modules/campaigns/campaign-automations.service';
import { CampaignsService } from '../src/modules/campaigns/campaigns.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Campañas y Comunicaciones: formato, versión en inglés, cupón,
 * prueba a uno mismo, programadas con la audiencia al salir, filtros finos y
 * segmentos guardados, resultados con contratos, WhatsApp, campañas
 * automáticas y herramientas del historial.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Mejoras de Campañas y Comunicaciones (e2e)', () => {
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

  async function waitCampaign(auth: Record<string, string>, id: string) {
    for (let i = 0; i < 60; i++) {
      const r = await http().get(`/campaigns/${id}`).set(auth);
      if (r.body.status !== 'sending') return r.body as { status: string; sentCount: number };
      await new Promise((res) => setTimeout(res, 200));
    }
    return (await http().get(`/campaigns/${id}`).set(auth)).body;
  }

  it('formato, versión en inglés, cupón y prueba a uno mismo', async () => {
    const owner = await registerVerifiedUser(app, 'cfa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const esEmail = `es-${Date.now()}@e2e.local`;
    const enEmail = `en-${Date.now()}@e2e.local`;
    const es = await createCustomer(app, owner.accessToken, { email: esEmail, firstName: 'Ana' });
    const en = await createCustomer(app, owner.accessToken, { email: enEmail, firstName: 'John' });
    await db.customer.update({ where: { id: en }, data: { locale: 'en' } });

    // Cupón inexistente: 400.
    const segment = { audience: 'customers', contractStatus: 'any' };
    const missing = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Sin cupón',
        subject: 'Hola',
        bodyText: 'Usa {{coupon.code}}',
        couponCode: 'NOEXISTE',
        segment,
      })
      .expect(400);
    expect(missing.body.code).toBe('coupon_not_found');
    // La variable del cupón solo vale con un cupón.
    await http()
      .post('/campaigns')
      .set(auth)
      .send({ name: 'Sin cupón', subject: 'Hola', bodyText: 'Usa {{coupon.code}}', segment })
      .expect(400);
    // La versión en inglés necesita asunto y mensaje.
    const half = await http()
      .post('/campaigns')
      .set(auth)
      .send({ name: 'Medio', subject: 'Hola', bodyText: 'Texto', subjectEn: 'Hi', segment })
      .expect(400);
    expect(half.body.code).toBe('english_version_incomplete');

    await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'vuelve10', name: 'Vuelve', discountType: 'percentage', discountValue: 10 })
      .expect(201);
    const preview = await http().post('/campaigns/preview').set(auth).send({ segment }).expect(200);
    expect(preview.body).toMatchObject({ audienceCount: 2, english: 1, recentlyContacted: 0 });

    const body = [
      'Hola {{customer.firstName}}, tenemos **un 10 %** con el código {{coupon.code}}.',
      'Más en [nuestra web](https://ejemplo.com/oferta).',
      '[[boton: Reservar | https://ejemplo.com/reservar]]',
    ].join('\n');
    const created = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Otoño',
        subject: 'Oferta para {{customer.firstName}}',
        bodyText: body,
        subjectEn: 'An offer for {{customer.firstName}}',
        bodyTextEn: 'Hi {{customer.firstName}}, use **{{coupon.code}}**.',
        couponCode: 'vuelve10',
        segment,
      })
      .expect(201);
    expect(created.body).toMatchObject({ couponCode: 'VUELVE10', subjectEn: expect.any(String) });
    expect(created.body.createdByName).toBeTruthy();

    // Prueba a uno mismo.
    const test = await http()
      .post('/campaigns/test-send')
      .set(auth)
      .send({
        subject: 'Oferta para {{customer.firstName}}',
        bodyText: body,
        couponCode: 'VUELVE10',
      })
      .expect(200);
    const testMail = await waitForEmail(test.body.sentTo, { subjectIncludes: '[Prueba]' });
    expect(testMail.Subject).toContain('Lucía');
    expect(testMail.HTML).toContain('<strong>un 10 %</strong>');
    expect(testMail.HTML).toContain('VUELVE10');

    await http().post(`/campaigns/${created.body.id}/send`).set(auth).expect(200);
    expect((await waitCampaign(auth, created.body.id)).sentCount).toBe(2);
    const comms = await db.communication.findMany({
      where: { tenantId: tenant.id, source: `campaign:${created.body.id}` },
    });
    const esComm = comms.find((c) => c.customerId === es)!;
    const enComm = comms.find((c) => c.customerId === en)!;
    expect(esComm.subject).toBe('Oferta para Ana');
    expect(esComm.bodyText).toContain('tenemos un 10 % con el código VUELVE10');
    expect(esComm.bodyText).toContain('nuestra web (https://ejemplo.com/oferta)');
    expect(esComm.bodyText).toContain('Reservar: https://ejemplo.com/reservar');
    expect(esComm.bodyHtml).toContain('<strong>un 10 %</strong>');
    expect(esComm.bodyHtml).toContain('/v1/public/campaign-click/');
    expect(esComm.bodyHtml).toContain('>Reservar</a>');
    expect(enComm.subject).toBe('An offer for John');
    expect(enComm.bodyText).toContain('use VUELVE10');

    // Los que recibieron algo hace poco salen en la vista previa y se pueden excluir.
    const again = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { ...segment, excludeRecentDays: 7 } })
      .expect(200);
    expect(again.body.audienceCount).toBe(0);
    const recent = await http().post('/campaigns/preview').set(auth).send({ segment }).expect(200);
    expect(recent.body.recentlyContacted).toBe(2);
  });

  it('una programada calcula la audiencia al salir', async () => {
    const owner = await registerVerifiedUser(app, 'cfb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const first = await createCustomer(app, owner.accessToken);
    const draft = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Mañana',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);
    const scheduled = await http().post(`/campaigns/${draft.body.id}/send`).set(auth).expect(200);
    expect(scheduled.body.status).toBe('scheduled');
    expect(
      await db.communication.count({
        where: { tenantId: tenant.id, source: `campaign:${draft.body.id}` },
      }),
    ).toBe(0);

    // Entretanto llega otro inquilino y el primero se da de baja.
    const second = await createCustomer(app, owner.accessToken);
    await db.customer.update({ where: { id: first }, data: { marketingOptOutAt: new Date() } });
    await db.campaign.update({
      where: { id: draft.body.id },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });
    await app.get(CampaignsService).dispatchScheduled();
    const done = await http().get(`/campaigns/${draft.body.id}`).set(auth).expect(200);
    expect(done.body).toMatchObject({ status: 'sent', sentCount: 1 });
    const comms = await db.communication.findMany({
      where: { tenantId: tenant.id, source: `campaign:${draft.body.id}` },
    });
    expect(comms.map((c) => c.customerId)).toEqual([second]);
  });

  it('filtros finos, segmentos guardados y resultados con contratos', async () => {
    const owner = await registerVerifiedUser(app, 'cfc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const withContract = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: withContract }, fac.facilityId);
    const prospect = await createCustomer(app, owner.accessToken);

    // Sin seguro: el del contrato no tiene.
    const noInsurance = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', withoutInsurance: true } })
      .expect(200);
    expect(noInsurance.body.audienceCount).toBe(1);
    // Antigüedad mínima de 3 meses: ninguno.
    const veterans = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', minMonths: 3 } })
      .expect(200);
    expect(veterans.body.audienceCount).toBe(0);

    const saved = await http()
      .post('/campaigns/segments')
      .set(auth)
      .send({ name: 'Sin seguro', segment: { audience: 'customers', withoutInsurance: true } })
      .expect(201);
    await http()
      .post('/campaigns/segments')
      .set(auth)
      .send({ name: 'sin seguro', segment: { audience: 'customers' } })
      .expect(409);
    const list = await http().get('/campaigns/segments').set(auth).expect(200);
    expect(list.body).toHaveLength(1);
    await http().delete(`/campaigns/segments/${saved.body.id}`).set(auth).expect(204);

    // A quien no tiene contrato, y luego firma.
    const campaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Capta',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'none' },
      })
      .expect(201);
    expect(campaign.body.audienceCount).toBe(1);
    await http().post(`/campaigns/${campaign.body.id}/send`).set(auth).expect(200);
    await waitCampaign(auth, campaign.body.id);
    await signedContractFor(app, owner.accessToken, { id: prospect }, fac.facilityId);
    const results = await http()
      .get(`/campaigns/${campaign.body.id}/results`)
      .set(auth)
      .expect(200);
    expect(results.body.conversions).toMatchObject({ contracts: 1, windowDays: 30 });
    expect(results.body.conversions.monthlyRevenue).toBeGreaterThan(0);
    const converted = await http()
      .get(`/campaigns/${campaign.body.id}/recipients?filter=converted`)
      .set(auth)
      .expect(200);
    expect(converted.body).toHaveLength(1);
    expect(converted.body[0]).toMatchObject({ customerId: prospect });
    expect(converted.body[0].detail).toContain('Firmó el contrato');
    await http().get(`/campaigns/${campaign.body.id}/recipients?filter=nope`).set(auth).expect(400);
  });

  it('campaña por WhatsApp con plantilla', async () => {
    const owner = await registerVerifiedUser(app, 'cfd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const c = await createCustomer(app, owner.accessToken, { firstName: 'Marta' });
    await db.customer.update({ where: { id: c }, data: { phone: '612345678' } });
    const noPhone = await createCustomer(app, owner.accessToken);
    expect(noPhone).toBeTruthy();
    const base = {
      name: 'WA',
      channel: 'whatsapp',
      subject: 'Promoción',
      bodyText: 'Plantilla de WhatsApp',
      segment: { audience: 'customers', contractStatus: 'any' },
    };
    const noTemplate = await http().post('/campaigns').set(auth).send(base).expect(400);
    expect(noTemplate.body.code).toBe('whatsapp_template_required');
    const withTemplate = {
      ...base,
      whatsappTemplate: { name: 'promo_otono', language: 'es', params: ['{{customer.firstName}}'] },
    };
    const off = await http().post('/campaigns').set(auth).send(withTemplate).expect(400);
    expect(off.body.code).toBe('whatsapp_not_configured');

    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    await http()
      .put('/settings/whatsapp')
      .set(auth)
      .send({
        phoneNumberId: `9${Date.now()}`,
        accessToken: 'EAAG-token-de-prueba-campanas',
        enabled: true,
      })
      .expect(200);
    const preview = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: base.segment, channel: 'whatsapp' })
      .expect(200);
    expect(preview.body.audienceCount).toBe(1);
    const created = await http().post('/campaigns').set(auth).send(withTemplate).expect(201);
    expect(created.body).toMatchObject({ channel: 'whatsapp', audienceCount: 1 });
    await http().post(`/campaigns/${created.body.id}/send`).set(auth).expect(200);
    expect((await waitCampaign(auth, created.body.id)).sentCount).toBe(1);
    const comm = await db.communication.findFirstOrThrow({
      where: { tenantId: tenant.id, source: `campaign:${created.body.id}` },
    });
    expect(comm).toMatchObject({
      channel: 'whatsapp',
      status: 'sent',
      recipient: '34612345678',
      isMarketing: true,
    });
    expect(comm.bodyText).toContain('Marta');
    const conversation = await db.whatsappConversation.findFirst({
      where: { tenantId: tenant.id, waId: '34612345678' },
    });
    expect(conversation?.customerId).toBe(c);
  });

  it('campañas automáticas: aniversario y contactos que no avanzan', async () => {
    const owner = await registerVerifiedUser(app, 'cfe');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const veteran = await createCustomer(app, owner.accessToken);
    const contract = await signedContractFor(
      app,
      owner.accessToken,
      { id: veteran },
      fac.facilityId,
    );
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    await db.contract.update({ where: { id: contract.contractId }, data: { signedAt: yearAgo } });
    const lead = await db.lead.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Lola',
        email: `lola-${Date.now()}@e2e.local`,
        source: 'web',
        status: 'contacted',
        marketingConsentAt: new Date(),
      },
    });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db.$executeRaw`UPDATE leads SET created_at = ${old}, updated_at = ${old} WHERE id = ${lead.id}::uuid`;

    const list = await http().get('/campaigns/automations').set(auth).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ kind: 'anniversary', enabled: false }),
      expect.objectContaining({ kind: 'cold_leads', enabled: false, days: 30 }),
    ]);
    await http()
      .put('/campaigns/automations/anniversary')
      .set(auth)
      .send({ enabled: true, bodyText: 'Hola {{customer.nombre}}' })
      .expect(400);
    await http()
      .put('/campaigns/automations/anniversary')
      .set(auth)
      .send({ enabled: true })
      .expect(200);
    await http()
      .put('/campaigns/automations/cold_leads')
      .set(auth)
      .send({ enabled: true, days: 30 })
      .expect(200);
    await http().put('/campaigns/automations/otra').set(auth).send({}).expect(400);

    const service = app.get(CampaignAutomationsService);
    expect(await service.runForTenant(tenant.id, 'anniversary')).toBe(1);
    expect(await service.runForTenant(tenant.id, 'anniversary')).toBe(0);
    expect(await service.runForTenant(tenant.id, 'cold_leads')).toBe(1);
    expect(await service.runForTenant(tenant.id, 'cold_leads')).toBe(0);
    const sources = (
      await db.communication.findMany({
        where: { tenantId: tenant.id, source: { startsWith: 'campaign_auto.' } },
        select: { source: true, customerId: true, leadId: true },
      })
    ).map((c) => c.source);
    expect(sources.sort()).toEqual(['campaign_auto.anniversary', 'campaign_auto.cold_leads']);
    const after = await http().get('/campaigns/automations').set(auth).expect(200);
    expect(after.body[0]).toMatchObject({ kind: 'anniversary', sentLast30Days: 1 });
  });

  it('historial: cifras, CSV, ver el correo, cancelar y direcciones con problemas', async () => {
    const owner = await registerVerifiedUser(app, 'cff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const badEmail = `rebota-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email: badEmail });
    const campaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Historial',
        subject: 'Hola',
        bodyText: 'Mira **esto**',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    await http().post(`/campaigns/${campaign.body.id}/send`).set(auth).expect(200);
    await waitCampaign(auth, campaign.body.id);
    const comm = await db.communication.findFirstOrThrow({
      where: { tenantId: tenant.id, source: `campaign:${campaign.body.id}` },
    });

    const onlyCampaigns = await http()
      .get('/communications/page?sourceGroup=campaigns')
      .set(auth)
      .expect(200);
    expect(onlyCampaigns.body.items.map((c: { id: string }) => c.id)).toEqual([comm.id]);
    await http().get('/communications/page?sourceGroup=otro').set(auth).expect(400);
    const stats = await http()
      .get('/communications/stats?sourceGroup=campaigns')
      .set(auth)
      .expect(200);
    expect(stats.body.total).toBe(1);

    const csv = await http().get('/communications/export').set(auth).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(badEmail);
    expect(csv.text).toContain('Campaña «Historial»');

    const preview = await http().get(`/communications/${comm.id}/preview`).set(auth).expect(200);
    expect(preview.body.html).toContain('<strong>esto</strong>');

    // Un envío programado se puede cancelar; uno ya enviado, no.
    const pending = await db.communication.create({
      data: {
        tenantId: tenant.id,
        channel: 'email',
        status: 'pending',
        recipient: badEmail,
        subject: 'Programado',
        bodyText: 'Texto',
        customerId,
        source: 'manual',
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });
    const cancelled = await http()
      .post(`/communications/${pending.id}/cancel`)
      .set(auth)
      .expect(200);
    expect(cancelled.body.status).toBe('skipped');
    expect(cancelled.body.errorMessage).toContain('Cancelado por');
    const again = await http().post(`/communications/${pending.id}/cancel`).set(auth).expect(409);
    expect(again.body.code).toBe('communication_not_cancellable');

    await db.emailSuppression.create({
      data: { email: badEmail, tenantId: null, scope: 'all', reason: 'hard_bounce', detail: '550' },
    });
    const problems = await http().get('/communications/problem-addresses').set(auth).expect(200);
    expect(problems.body).toEqual([
      expect.objectContaining({
        email: badEmail,
        reason: 'hard_bounce',
        label: 'La dirección no existe',
        customerId,
      }),
    ]);
  });
});
