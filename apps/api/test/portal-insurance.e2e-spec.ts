import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal — seguro self-service (e2e)', () => {
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

  it('el inquilino ve los planes y contrata/quita el seguro en su contrato', async () => {
    const owner = await registerVerifiedUser(app, 'pinsurance');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `pins-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Plan de seguro (staff).
    const plan = await request(app.getHttpServer())
      .post('/insurance-plans')
      .set(auth)
      .send({ name: 'Protección Básica', monthlyPrice: 5, coverageAmount: 1000 });
    expect(plan.status).toBe(201);
    const planId = plan.body.id as string;

    // Contrato firmado (active).
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 80 });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Lista de planes disponibles.
    const plans = await request(app.getHttpServer()).get('/portal/me/insurance-plans').set(pAuth);
    expect(plans.status).toBe(200);
    expect(plans.body.some((p: { id: string }) => p.id === planId)).toBe(true);

    // Contratar.
    const set = await request(app.getHttpServer())
      .put(`/portal/me/contracts/${contractId}/insurance`)
      .set(pAuth)
      .send({ planId });
    expect(set.status).toBe(200);
    const withIns = set.body.find((c: { id: string }) => c.id === contractId);
    expect(withIns.insurancePlanId).toBe(planId);
    expect(withIns.insurancePlanName).toBe('Protección Básica');
    expect(withIns.insurancePrice).toBe(5);

    // Quitar.
    const unset = await request(app.getHttpServer())
      .put(`/portal/me/contracts/${contractId}/insurance`)
      .set(pAuth)
      .send({ planId: null });
    const without = unset.body.find((c: { id: string }) => c.id === contractId);
    expect(without.insurancePlanId).toBeNull();
  });

  it('no puede tocar el seguro de un contrato ajeno', async () => {
    const owner = await registerVerifiedUser(app, 'pinsx');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const emailA = `pinsa-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    await createCustomer(app, owner.accessToken, { email: emailA });
    const customerB = await createCustomer(app, owner.accessToken, {
      email: `pinsb-${Date.now()}@e2e.local`,
    });
    const cB = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId: customerB,
        unitId: unitIds[1],
        startDate: '2026-01-01',
        priceMonthly: 60,
      });
    const contractB = cB.body.id as string;

    const tokenA = await portalLogin(owner.slug, emailA);
    const res = await request(app.getHttpServer())
      .put(`/portal/me/contracts/${contractB}/insurance`)
      .set({ Authorization: `Bearer ${tokenA}` })
      .send({ planId: null });
    expect(res.status).toBe(404);
  });
});
