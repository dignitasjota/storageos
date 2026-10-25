import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ReviewRequestCron } from '../src/modules/reviews/review-request.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión del CRM: contactos repetidos, «ganado» solo al convertir, cliente
 * existente al convertir, contrato enlazado al contacto, ex-clientes firmados,
 * campañas por local, programadas y canceladas, oportunidades con baja
 * comercial, testimonios moderados, valoraciones caducadas y en ventana y
 * presupuesto a quien ya fue cliente.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

describe('Revisión del CRM (e2e)', () => {
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

  async function signedContract(
    token: string,
    customerId: string,
    unitId: string,
    startDate = '2026-01-01',
  ): Promise<string> {
    const auth = { Authorization: `Bearer ${token}` };
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate, priceMonthly: 50, depositAmount: 0 });
    expect(c.status).toBe(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return c.body.id as string;
  }

  it('contactos: repetidos, ganado solo convirtiendo y contrato enlazado', async () => {
    const owner = await registerVerifiedUser(app, 'crmleads');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `repe-${Date.now()}@e2e.local`;
    const widget = (message: string) =>
      http().post(`/public/widget/${owner.slug}/leads`).send({
        firstName: 'Rita',
        email,
        phone: '+34 600 111 999',
        message,
        hp: '',
        acceptsTerms: true,
        acceptsMarketing: false,
      });
    const first = await widget('Busco 5 m²');
    expect(first.status).toBe(201);
    const second = await widget('¿Tenéis algo más grande?');
    expect(second.status).toBe(201);
    // El segundo mensaje se suma al contacto existente.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.message).toContain('Busco 5 m²');
    expect(second.body.message).toContain('¿Tenéis algo más grande?');

    // «Ganado» no se puede poner a mano: hay que convertirlo.
    const won = await http()
      .post(`/leads/${first.body.id}/transition`)
      .set(auth)
      .send({ status: 'won' });
    expect(won.status).toBe(409);
    expect(won.body.code).toBe('lead_use_convert');

    // Ya existe un inquilino con ese email: la conversión lo reutiliza.
    const existingId = await createCustomer(app, owner.accessToken, { email: email.toUpperCase() });
    const converted = await http().post(`/leads/${first.body.id}/convert`).set(auth).send({});
    expect(converted.status).toBe(201);
    expect(converted.body.convertedCustomerId).toBe(existingId);

    // Al firmar su contrato, el contacto queda enlazado (cuenta en su canal).
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const contractId = await signedContract(owner.accessToken, existingId, unitIds[0]!);
    let linked: string | null = null;
    for (let i = 0; i < 20 && !linked; i++) {
      const lead = await db.lead.findUnique({ where: { id: first.body.id } });
      linked = lead?.convertedContractId ?? null;
      if (!linked) await sleep(200);
    }
    expect(linked).toBe(contractId);
  });

  it('campañas: ex-clientes firmados, por local, programadas y canceladas', async () => {
    const owner = await registerVerifiedUser(app, 'crmcamp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const b = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    // Reserva sin firmar y cancelada: NO es ex-cliente.
    const neverId = await createCustomer(app, owner.accessToken);
    const draft = await http().post('/contracts').set(auth).send({
      customerId: neverId,
      unitId: a.unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await http().post(`/contracts/${draft.body.id}/cancel`).set(auth).send({ reason: 'no firma' });
    // Contrato firmado y terminado: SÍ es ex-cliente.
    const formerId = await createCustomer(app, owner.accessToken);
    const formerContract = await signedContract(owner.accessToken, formerId, a.unitIds[1]!);
    await http().post(`/contracts/${formerContract}/end`).set(auth).send({}).expect(200);

    const former = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'former' } });
    expect(former.status).toBe(200);
    expect(former.body.audienceCount).toBe(1);

    // Por local: un cliente activo en el local B.
    const activeB = await createCustomer(app, owner.accessToken);
    await signedContract(owner.accessToken, activeB, b.unitIds[0]!);
    const byLocal = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({
        segment: { audience: 'customers', contractStatus: 'active', facilityId: b.facilityId },
      });
    expect(byLocal.body.audienceCount).toBe(1);
    const otherLocal = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({
        segment: { audience: 'customers', contractStatus: 'active', facilityId: a.facilityId },
      });
    expect(otherLocal.body.audienceCount).toBe(0);

    // Programada: queda «programada» y se puede cancelar sin que salga nada.
    const campaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Mañana',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Oferta para ti',
        segment: { audience: 'customers', contractStatus: 'active', facilityId: b.facilityId },
        scheduledFor: new Date(Date.now() + 2 * DAY).toISOString(),
      });
    expect(campaign.status).toBe(201);
    await http().post(`/campaigns/${campaign.body.id}/send`).set(auth).expect(200);
    let status = '';
    for (let i = 0; i < 25 && status !== 'scheduled'; i++) {
      status = (await http().get(`/campaigns/${campaign.body.id}`).set(auth)).body.status;
      if (status !== 'scheduled') await sleep(200);
    }
    expect(status).toBe('scheduled');
    const cancelled = await http().post(`/campaigns/${campaign.body.id}/cancel`).set(auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    const comms = await db.communication.findMany({
      where: { source: `campaign:${campaign.body.id}` },
    });
    expect(comms.length).toBe(1);
    expect(comms.every((c) => c.status === 'skipped')).toBe(true);
    // Una enviada ya no se cancela.
    await http().post(`/campaigns/${campaign.body.id}/cancel`).set(auth).expect(409);
  });

  it('oportunidades: sin baja comercial y sin «domiciliar» si no hay cómo', async () => {
    const owner = await registerVerifiedUser(app, 'crmopp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const okId = await createCustomer(app, owner.accessToken);
    const outId = await createCustomer(app, owner.accessToken);
    await signedContract(owner.accessToken, okId, unitIds[0]!);
    await signedContract(owner.accessToken, outId, unitIds[1]!);
    await http().post(`/customers/${outId}/marketing`).set(auth).send({ subscribed: false });

    const list = await http().get('/opportunities').set(auth);
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { customerId: string }) => i.customerId);
    expect(ids).not.toContain(outId);
    // El tenant no tiene ni tarjeta, ni GoCardless, ni SEPA: no se propone domiciliar.
    expect(list.body.items.some((i: { kind: string }) => i.kind === 'autopay')).toBe(false);
  });

  it('valoraciones: publicar en la web, caducadas y ventana del envío automático', async () => {
    const owner = await registerVerifiedUser(app, 'crmrev');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signedContract(owner.accessToken, customerId, unitIds[0]!);

    const requested = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, contractId, channel: 'email' });
    expect(requested.status).toBe(201);
    // Pendiente: no se puede publicar.
    await http()
      .patch(`/reviews/${requested.body.id}/web`)
      .set(auth)
      .send({ published: true })
      .expect(400);
    const token = requested.body.reviewUrl.split('/').pop();
    await http()
      .post(`/public/reviews/${token}`)
      .send({ npsScore: 10, comment: 'Muy limpio y cómodo' })
      .expect(201);
    const listed = await http().get('/reviews').set(auth);
    expect(listed.body.items[0].publishedOnWeb).toBe(false);
    const published = await http()
      .patch(`/reviews/${requested.body.id}/web`)
      .set(auth)
      .send({ published: true });
    expect(published.status).toBe(200);
    expect(published.body.publishedOnWeb).toBe(true);

    // Una pendiente caducada cuenta como caducada, aunque nadie la abra.
    const old = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, channel: 'email' });
    await db.review.update({
      where: { id: old.body.id },
      data: { tokenExpiresAt: new Date(Date.now() - DAY) },
    });
    const stats = await http().get('/reviews/stats').set(auth);
    expect(stats.body.pending).toBe(0);

    // Envío automático: solo los firmados poco después del plazo (no los de hace años).
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { reviewsAutoRequest: true, reviewRequestDelayDays: 30 },
    });
    const recentId = await createCustomer(app, owner.accessToken);
    const oldId = await createCustomer(app, owner.accessToken);
    const recent = await signedContract(owner.accessToken, recentId, unitIds[1]!);
    const ancient = await signedContract(owner.accessToken, oldId, unitIds[2]!);
    await db.contract.update({
      where: { id: recent },
      data: { signedAt: new Date(Date.now() - 35 * DAY) },
    });
    await db.contract.update({
      where: { id: ancient },
      data: { signedAt: new Date(Date.now() - 400 * DAY) },
    });
    await app.get(ReviewRequestCron).run();
    expect(await db.review.count({ where: { contractId: recent } })).toBe(1);
    expect(await db.review.count({ where: { contractId: ancient } })).toBe(0);
  });

  it('presupuesto: quien ya fue cliente no usa un cupón de clientes nuevos', async () => {
    const owner = await registerVerifiedUser(app, 'crmquote');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 2, pricePerUnit: 50 },
    );
    await http()
      .post('/coupons')
      .set(auth)
      .send({
        code: 'BIENVENIDA',
        name: 'Bienvenida',
        discountType: 'percentage',
        discountValue: 10,
        newCustomersOnly: true,
      })
      .expect(201);
    const email = `ya-cliente-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    await signedContract(owner.accessToken, customerId, unitIds[0]!);
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Vuelve', email, source: 'manual' })
      .expect(201);
    const preview = await http()
      .post(`/leads/${lead.body.id}/quote/preview`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 1, couponCode: 'BIENVENIDA' });
    expect(preview.status).toBe(200);
    expect(preview.body.quote.coupon).toMatchObject({ valid: false });
  });
});
