import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Oportunidades: señales del área de clientes → qué ofrecer y propuesta en un clic. */
describe('Oportunidades sobre los inquilinos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

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

  it('señales del portal, oportunidades, borrador y propuesta', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'opps');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `opps-${Date.now()}@example.com`,
    });

    await http()
      .post('/insurance-plans')
      .set(auth)
      .send({ name: 'Protección Básica', monthlyPrice: 5, coverageAmount: 1000 })
      .expect(201);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { nightPassEnabled: true, nightPassPrice: 5 },
    });

    // Sesión del área de clientes con un enlace del panel.
    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url).searchParams.get('token');
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const pAuth = { Authorization: `Bearer ${session.body.accessToken}` };

    await http().post('/portal/me/interest').set(pAuth).send({ kind: 'insurance' }).expect(204);
    await http().post('/portal/me/interest').set(pAuth).send({ kind: 'insurance' }).expect(204);
    await http().post('/portal/me/interest').set(pAuth).send({ kind: 'bogus' }).expect(204);
    expect(await db.customerInterestEvent.count({ where: { customerId } })).toBe(1);
    await http().post('/portal/me/interest').send({ kind: 'insurance' }).expect(401);

    const device = await db.accessDevice.findFirst({ where: { tenantId: owner.tenantId } });
    if (device) {
      await db.accessLog.create({
        data: {
          tenantId: owner.tenantId,
          deviceId: device.id,
          customerId,
          method: 'pin',
          result: 'denied_outside_hours',
        },
      });
    }

    const list = await http().get('/opportunities').set(auth).expect(200);
    const mine = list.body.items.filter((i: { customerId: string }) => i.customerId === customerId);
    const insurance = mine.find((i: { kind: string }) => i.kind === 'insurance');
    expect(insurance).toMatchObject({ priceMonthlyGross: 6.05, monthlyValue: 5, score: 70 });
    expect(insurance.reason).toMatch(/Miró el seguro/);
    expect(mine.map((i: { kind: string }) => i.kind)).toContain('autopay');
    expect(list.body.byKind.insurance.count).toBeGreaterThanOrEqual(1);

    const draft = await http()
      .get(`/opportunities/draft?customerId=${customerId}&kind=insurance`)
      .set(auth)
      .expect(200);
    expect(draft.body.body).toContain('6,05');
    expect(draft.body.portalUrl).toContain('/portal/login');
    await http()
      .get(`/opportunities/draft?customerId=${customerId}&kind=larger_unit`)
      .set(auth)
      .expect(404);

    const sent = await http()
      .post('/opportunities/propose')
      .set(auth)
      .send({ customerId, kind: 'insurance', followupInDays: 7 })
      .expect(201);
    expect(sent.body).toMatchObject({ emailSent: true });
    expect(sent.body.followupId).toBeTruthy();
    const comm = await db.communication.findFirst({
      where: { customerId, source: 'opportunity:insurance' },
    });
    expect(comm?.subject).toBe('Protege lo que guardas en tu trastero');

    const again = await http().get('/opportunities').set(auth).expect(200);
    const after = again.body.items.find(
      (i: { customerId: string; kind: string }) =>
        i.customerId === customerId && i.kind === 'insurance',
    );
    expect(after.lastProposedAt).toBeTruthy();
    expect(after.score).toBe(23);
    expect(after.lastOfferStatus).toBe('open');

    // La propuesta sale en su área de clientes con «Me interesa».
    const offers = await http().get('/portal/me/offers').set(pAuth).expect(200);
    expect(offers.body).toHaveLength(1);
    expect(offers.body[0]).toMatchObject({ kind: 'insurance', priceGross: 6.05, status: 'open' });
    const resp = await http()
      .post(`/portal/me/offers/${offers.body[0].id}/respond`)
      .set(pAuth)
      .send({ response: 'interested' })
      .expect(200);
    expect(resp.body[0].status).toBe('interested');
    const notif = await db.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'customer.offer_interested' },
    });
    expect(notif).toBeTruthy();
    await http()
      .post(`/portal/me/offers/${offers.body[0].id}/respond`)
      .set(pAuth)
      .send({ response: 'bogus' })
      .expect(400);

    // Al contratar el seguro la propuesta se da por aceptada.
    const plan = await db.insurancePlan.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    await new Promise((r) => setTimeout(r, 20));
    await http()
      .put(`/portal/me/contracts/${contract.body.id}/insurance`)
      .set(pAuth)
      .send({ planId: plan.id })
      .expect(200);
    const offersAfter = await http().get('/portal/me/offers').set(pAuth).expect(200);
    expect(offersAfter.body).toHaveLength(0);
    const row = await db.customerOffer.findFirstOrThrow({ where: { customerId } });
    expect(row.status).toBe('accepted');

    await http().get('/portal/me/offers').expect(401);
    await http().get('/opportunities').expect(401);
  });
});
