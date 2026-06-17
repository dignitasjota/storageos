import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function tokenFromUrl(url: string): string {
  const marker = '/sign/';
  return url.slice(url.indexOf(marker) + marker.length);
}

describe('Move-in: firma electrónica + booking (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('staff solicita firma → cliente firma por enlace → contrato activo', async () => {
    const owner = await registerVerifiedUser(app, 'movein-sign');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: 'firmante@e2e.local',
    });

    const contractRes = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 50,
        billingCycle: 'monthly',
      });
    expect(contractRes.status).toBe(201);
    const contractId = contractRes.body.id as string;

    const reqSig = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-signature`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(reqSig.status).toBe(201);
    const token = tokenFromUrl(reqSig.body.signingUrl as string);
    expect(token).toContain('.');

    // Vista pública del contrato a firmar.
    const view = await request(app.getHttpServer()).get(`/public/move-in/sign/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.alreadySigned).toBe(false);
    expect(view.body.termsText).toContain(view.body.contractNumber);

    // Firma pública.
    const signed = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${token}`)
      .send({
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
      });
    expect(signed.status).toBe(201);
    expect(signed.body.status).toBe('active');

    // El contrato quedó activo y hay registro de firma.
    const detail = await request(app.getHttpServer())
      .get(`/contracts/${contractId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('active');

    const sigs = await request(app.getHttpServer())
      .get(`/contracts/${contractId}/signatures`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(sigs.status).toBe(200);
    expect(sigs.body).toHaveLength(1);
    expect(sigs.body[0].method).toBe('typed');
  });

  it('token inválido → 401', async () => {
    const res = await request(app.getHttpServer()).get('/public/move-in/sign/no-existe.malo');
    expect(res.status).toBe(401);
  });

  it('booking público: disponibilidad + alta → token de firma → firma', async () => {
    const owner = await registerVerifiedUser(app, 'movein-book');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Book',
      typeName: 'Mediano',
      unitsCount: 2,
    });

    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    expect(avail.status).toBe(200);
    const facility = avail.body.facilities[0];
    expect(facility.unitTypes[0].available).toBeGreaterThan(0);

    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: { firstName: 'Bea', lastName: 'López', email: 'bea@e2e.local' },
      });
    expect(booking.status).toBe(201);
    expect(booking.body.signingToken).toContain('.');

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
  });

  it('booking con honeypot relleno → 400', async () => {
    const owner = await registerVerifiedUser(app, 'movein-spam');
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const res = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: '2026-03-01',
        customer: { firstName: 'Bot', lastName: 'Spam', email: 'bot@e2e.local' },
        website: 'http://spam.example',
      });
    expect(res.status).toBe(400);
  });
});
