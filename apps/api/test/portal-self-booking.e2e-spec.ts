import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: self-service de contratación de trastero (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el inquilino contrata un trastero disponible y se le emite la 1ª factura', async () => {
    const owner = await registerVerifiedUser(app, 'selfbook');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local SB', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 60, defaultDepositAmount: 50 });
    const unitTypeId = unitType.body.id as string;
    const u1 = await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        code: 'SB-001',
        widthM: 2,
        depthM: 2,
        heightM: 2.5,
        basePriceMonthly: 60,
      });
    const u2 = await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        code: 'SB-002',
        widthM: 2,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: 80,
      });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Leo',
        lastName: 'Paz',
        email: 'leo-sb@x.com',
      });
    const customerId = customer.body.id as string;

    // Contrato activo en el local (para que el self-service le permita el local).
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: u1.body.id, priceMonthly: 60, startDate: '2026-01-01' });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({});

    // Sesión de portal.
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const portalAuth = { Authorization: `Bearer ${consume.body.accessToken}` };

    // Contrata el trastero disponible SB-002.
    const booked = await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .set(portalAuth)
      .send({ unitId: u2.body.id, signerName: 'Leo Paz' });
    expect(booked.status).toBe(201);
    expect(booked.body.contractId).toBeTruthy();
    expect(booked.body.invoiceId).toBeTruthy();
    expect(booked.body.portalToken).toBeTruthy();

    // La factura aparece en sus facturas del portal (emitida).
    const invoices = await request(app.getHttpServer()).get('/portal/me/invoices').set(portalAuth);
    expect(invoices.body.some((i: { id: string }) => i.id === booked.body.invoiceId)).toBe(true);

    // SB-002 ya no está disponible.
    const available = await request(app.getHttpServer())
      .get('/portal/me/available-units')
      .set(portalAuth);
    expect(available.body.map((u: { code: string }) => u.code)).not.toContain('SB-002');

    // Sin sesión → 401.
    await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .send({ unitId: u2.body.id, signerName: 'Leo Paz' })
      .expect(401);
  });
});
