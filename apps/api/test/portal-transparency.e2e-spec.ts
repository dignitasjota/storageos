import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal — transparencia del inquilino (e2e)', () => {
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

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('expone contrato enriquecido + local + pagos + descarga de contrato', async () => {
    const owner = await registerVerifiedUser(app, 'transparency');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `transp-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 80,
      depositAmount: 100,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Contrato enriquecido.
    const contracts = await request(app.getHttpServer()).get('/portal/me/contracts').set(pAuth);
    expect(contracts.status).toBe(200);
    const c = contracts.body[0];
    expect(c).toMatchObject({ depositAmount: 100, freeMonthsRemaining: 0, hasSignedPdf: false });
    expect(c).toHaveProperty('depositStatus');
    expect(c).toHaveProperty('insurancePlanName');

    // Datos del local.
    const facilities = await request(app.getHttpServer()).get('/portal/me/facilities').set(pAuth);
    expect(facilities.status).toBe(200);
    expect(facilities.body.length).toBeGreaterThanOrEqual(1);
    expect(facilities.body[0]).toHaveProperty('name');
    expect(facilities.body[0]).toHaveProperty('accessCurfewEnabled');

    // Historial de pagos (vacío pero responde array).
    const payments = await request(app.getHttpServer()).get('/portal/me/payments').set(pAuth);
    expect(payments.status).toBe(200);
    expect(Array.isArray(payments.body)).toBe(true);

    // Descargar contrato firmado: aún no hay PDF → 404 controlado.
    const pdf = await request(app.getHttpServer())
      .get(`/portal/me/contracts/${contractId}/signed-pdf`)
      .set(pAuth);
    expect(pdf.status).toBe(404);
    expect(pdf.body.code).toBe('signed_pdf_not_available');
  });

  it('los endpoints exigen sesión de portal', async () => {
    const r1 = await request(app.getHttpServer()).get('/portal/me/payments');
    expect(r1.status).toBe(401);
    const r2 = await request(app.getHttpServer()).get('/portal/me/facilities');
    expect(r2.status).toBe(401);
  });
});
