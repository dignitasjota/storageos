import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Portal: historial de pases nocturnos (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  async function portalAuthFor(
    ownerToken: string,
    customer: { firstName: string; lastName: string; email: string },
  ): Promise<{ headers: { Authorization: string }; customerId: string }> {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const created = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', ...customer });
    const customerId = created.body.id as string;
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return { headers: { Authorization: `Bearer ${consume.body.accessToken}` }, customerId };
  }

  // Cobro en el acto (decisión de negocio): un pase con precio se cobra contra
  // el método de pago por defecto del inquilino ANTES de emitir el PIN. Sin
  // método → 400 y no se emite nada (el PIN es usable de inmediato, no puede
  // entregarse gratis).
  it('con precio y sin método de pago → 400 y NO se emite el pase', async () => {
    const owner = await registerVerifiedUser(app, 'nightpass');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 5 })
      .expect(200);

    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Sol',
      lastName: 'Noche',
      email: 'sol-np@x.com',
    });

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/portal/me/access/night-passes').expect(401);

    // Comprar sin método de pago → 400 `no_payment_method`.
    const buy = await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers);
    expect(buy.status).toBe(400);
    expect(buy.body.code).toBe('no_payment_method');

    // No se ha emitido ningún pase.
    const history = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth.headers);
    expect(history.body).toHaveLength(0);
  });

  it('pase gratuito (precio 0) se entrega sin cobro', async () => {
    const owner = await registerVerifiedUser(app, 'nightpassfree');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);

    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Luna',
      lastName: 'Gratis',
      email: 'luna-np@x.com',
    });

    await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .expect(201);

    const history = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth.headers);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].status).toBe('active');
  });

  it('con varios locales hay que elegir uno y el PIN solo abre ese local', async () => {
    const owner = await registerVerifiedUser(app, 'nightpassfac');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);

    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Estela',
      lastName: 'Dos',
      email: 'estela-np@x.com',
    });
    const a = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Norte',
      unitsCount: 1,
    });
    const b = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sur',
      unitsCount: 1,
    });
    for (const unitId of [a.unitIds[0], b.unitIds[0]]) {
      const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
        customerId: portalAuth.customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 60,
      });
      await request(app.getHttpServer())
        .post(`/contracts/${contract.body.id}/sign`)
        .set(auth)
        .send({})
        .expect(200);
    }

    const info = await request(app.getHttpServer())
      .get('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .expect(200);
    expect(info.body.facilities.map((f: { name: string }) => f.name)).toEqual([
      'Local Norte',
      'Local Sur',
    ]);

    // Sin elegir local → 400; un local ajeno → 400.
    const noFacility = await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .send({});
    expect(noFacility.status).toBe(400);
    expect(noFacility.body.code).toBe('facility_required');
    const foreign = await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .send({ facilityId: '00000000-0000-4000-8000-000000000000' });
    expect(foreign.body.code).toBe('facility_not_allowed');

    const bought = await request(app.getHttpServer())
      .post('/portal/me/access/night-pass')
      .set(portalAuth.headers)
      .send({ facilityId: a.facilityId })
      .expect(201);

    const cred = await adminClient.accessCredential.findUniqueOrThrow({
      where: { id: bought.body.id },
    });
    expect(cred.allowedFacilityIds).toEqual([a.facilityId]);
    expect(cred.allowedUnitIds).toEqual([a.unitIds[0]]);

    const history = await request(app.getHttpServer())
      .get('/portal/me/access/night-passes')
      .set(portalAuth.headers);
    expect(history.body[0].facilityName).toBe('Local Norte');
  });

  it('una factura imputada a un local (sin contrato) entra en la caja de ese local', async () => {
    const owner = await registerVerifiedUser(app, 'nightpasscash');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const portalAuth = await portalAuthFor(owner.accessToken, {
      firstName: 'Caja',
      lastName: 'Local',
      email: 'caja-np@x.com',
    });
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken);

    // Mismo patrón que el pase nocturno: factura sin contrato con `facilityId`.
    const inv = await createDraftInvoice(app, owner.accessToken, portalAuth.customerId, {
      unitPrice: 100,
    });
    await adminClient.invoice.update({ where: { id: inv }, data: { facilityId } });
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const summary = await request(app.getHttpServer())
      .get(`/cash/summary?date=${today}&facilityId=${facilityId}`)
      .set(auth)
      .expect(200);
    expect(summary.body.cash).toBe(121);
  });
});
