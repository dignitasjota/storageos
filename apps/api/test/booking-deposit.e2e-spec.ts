import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Reserva online con fianza (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('la 1ª factura del booking incluye la fianza del tipo (línea IVA 0)', async () => {
    const owner = await registerVerifiedUser(app, 'bookdep');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });

    // El tenant configura una fianza de 60 € en el tipo de trastero.
    await request(app.getHttpServer())
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ defaultDepositAmount: 60 })
      .expect(200);

    // Reserva pública.
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: { firstName: 'Bea', lastName: 'López', email: `dep-${Date.now()}@e2e.local` },
      });
    expect(booking.status).toBe(201);
    const contractId = booking.body.contractId as string;

    // Firma → emite la 1ª factura.
    const signed = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        signerName: 'Bea López',
        method: 'typed',
        typedSignature: 'Bea López',
        accept: true,
      });
    expect(signed.status).toBe(201);
    expect(signed.body.status).toBe('active');

    // La factura del contrato tiene línea de alquiler (IVA 21) + fianza (IVA 0).
    const list = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    const invoiceId = (list.body.items ?? list.body)[0].id as string;
    const inv = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(inv.status).toBe(200);

    const items = inv.body.items as { description: string; taxRate: number; unitPrice: number }[];
    const deposit = items.find((i) => i.description.toLowerCase().includes('fianza'));
    expect(deposit).toBeDefined();
    expect(deposit!.taxRate).toBe(0);
    expect(deposit!.unitPrice).toBe(60);
    const rent = items.find((i) => i.description.toLowerCase().includes('alquiler'));
    expect(rent).toBeDefined();
    expect(rent!.taxRate).toBe(21);
  });
});
