import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Solicitud de trastero adicional (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el inquilino solicita un trastero adicional y el staff lo gestiona', async () => {
    const owner = await registerVerifiedUser(app, 'unitreq');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Crear local + tipo + trastero + inquilino + contrato activo.
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local UR', addressLine1: 'C/ Test 1', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;

    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 60 });
    const unitTypeId = unitType.body.id as string;

    // Un trastero ocupado (del contrato) y otro disponible (para solicitar).
    const u1 = await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        code: 'UR-001',
        widthM: 2,
        depthM: 2,
        heightM: 2.5,
        basePriceMonthly: 60,
      });
    const occupiedUnitId = u1.body.id as string;
    await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        code: 'UR-002',
        widthM: 2,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: 70,
      });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Ana',
        lastName: 'Ruiz',
        email: 'ana-ur@x.com',
      });
    const customerId = customer.body.id as string;

    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: occupiedUnitId, priceMonthly: 60, startDate: '2026-01-01' });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({});

    // Magic link del portal para el inquilino.
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const url = new URL(link.body.url);
    const token = url.searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const portalAuth = { Authorization: `Bearer ${consume.body.accessToken}` };

    // El inquilino ve disponibilidad: el trastero UR-002 (UR-001 está ocupado).
    const available = await request(app.getHttpServer())
      .get('/portal/me/available-units')
      .set(portalAuth);
    expect(available.status).toBe(200);
    const codes = available.body.map((u: { code: string }) => u.code);
    expect(codes).toContain('UR-002');
    expect(codes).not.toContain('UR-001');

    // Solicita el disponible.
    const target = available.body.find((u: { code: string }) => u.code === 'UR-002');
    const req = await request(app.getHttpServer())
      .post('/portal/me/unit-requests')
      .set(portalAuth)
      .send({ unitId: target.id, note: 'Quiero otro' });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');

    // El staff la ve en su cola y la gestiona.
    const staffList = await request(app.getHttpServer())
      .get('/unit-requests?status=pending')
      .set(auth);
    expect(staffList.body.length).toBe(1);
    expect(staffList.body[0].unitCode).toBe('UR-002');

    const resolved = await request(app.getHttpServer())
      .patch(`/unit-requests/${staffList.body[0].id}`)
      .set(auth)
      .send({ status: 'handled', resolutionNote: 'Contactado' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('handled');

    // Sin sesión de portal → 401.
    await request(app.getHttpServer()).get('/portal/me/available-units').expect(401);
  });
});
