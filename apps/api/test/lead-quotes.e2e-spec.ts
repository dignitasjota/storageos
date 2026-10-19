import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Presupuesto a un contacto con el enlace a la reserva ya rellenada. */
describe('Presupuesto a un contacto (e2e)', () => {
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

  it('calcula, redacta y envía el presupuesto', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'leadquote');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await http()
      .post('/coupons')
      .set(auth)
      .send({
        code: 'TRES2',
        name: '3x2',
        discountType: 'free_months',
        discountValue: 1,
        minMonths: 3,
      })
      .expect(201);
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Ana', email: 'ana.quote@example.com', source: 'idealista' })
      .expect(201);

    const preview = await http()
      .post(`/leads/${lead.body.id}/quote/preview`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 3, couponCode: 'TRES2' })
      .expect(200);
    expect(preview.body.quote).toMatchObject({ months: 3, freeMonths: 1, rentTotalWithVat: 121 });
    expect(preview.body.quote.coupon).toMatchObject({ code: 'TRES2', valid: true });
    expect(preview.body.bookUrl).toContain(`/book/${owner.slug}?facilityId=${facilityId}`);
    expect(preview.body.bookUrl).toContain('coupon=TRES2');
    expect(preview.body.bookUrl).toContain('months=3');
    expect(preview.body.bookUrl).toContain('utm_source=presupuesto');
    expect(preview.body.body).toContain('Hola Ana');
    expect(preview.body.body).toContain('121,00');

    const sent = await http()
      .post(`/leads/${lead.body.id}/quote/send`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 3, couponCode: 'TRES2' })
      .expect(201);
    expect(sent.body.sentTo).toBe('ana.quote@example.com');
    const row = await db.lead.findUnique({ where: { id: lead.body.id } });
    expect(row).toMatchObject({ status: 'contacted', preferredUnitTypeId: unitTypeId });
    const comm = await db.communication.findFirst({
      where: { leadId: lead.body.id, source: 'lead.quote' },
    });
    expect(comm?.subject).toMatch(/Tu presupuesto de trastero/);

    const noEmail = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Sin', phone: '600111222', source: 'llamada' })
      .expect(201);
    await http()
      .post(`/leads/${noEmail.body.id}/quote/send`)
      .set(auth)
      .send({ facilityId, unitTypeId, months: 1 })
      .expect(400);
    await http().post(`/leads/${lead.body.id}/quote/preview`).send({}).expect(401);
  });
});
