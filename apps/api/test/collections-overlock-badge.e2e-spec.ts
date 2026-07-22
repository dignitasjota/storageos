import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Badge de overlock: la ficha del contrato (staff) y el portal del inquilino
 * reflejan que hay un expediente de impago con el candado puesto.
 */
describe('Overlock badge (staff + portal) (e2e)', () => {
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
    const consume = await request(app.getHttpServer()).post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('marca overlocked cuando el expediente tiene el candado puesto', async () => {
    const owner = await registerVerifiedUser(app, 'overlock-badge');
    await setTenantPlan(owner.slug, 'starter'); // starter incluye collections
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `overlock-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Contrato firmado + factura vencida (deuda) para poder abrir el expediente.
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 100, depositAmount: 0 });
    const contractId = contract.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);
    await ensureDefaultSeries(app, owner.accessToken);
    const invoice = await request(app.getHttpServer())
      .post('/invoices')
      .set(auth)
      .send({ customerId, contractId, items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }] });
    await request(app.getHttpServer()).post(`/invoices/${invoice.body.id}/issue`).set(auth).expect(200);

    // Sin expediente → by-contract devuelve null.
    const before = await request(app.getHttpServer())
      .get(`/collections/by-contract/${contractId}`)
      .set(auth);
    expect(before.status).toBe(200);
    expect(before.body.case).toBeNull();

    // Abrir expediente + poner candado.
    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;
    await request(app.getHttpServer())
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ notes: 'Candado colocado' })
      .expect(200);

    // Staff: by-contract devuelve el expediente overlocked.
    const staff = await request(app.getHttpServer())
      .get(`/collections/by-contract/${contractId}`)
      .set(auth);
    expect(staff.body.case).not.toBeNull();
    expect(staff.body.case.id).toBe(caseId);
    expect(staff.body.case.status).toBe('overlocked');
    expect(staff.body.case.debtCents).toBe(12100);

    // Portal: el contrato del inquilino sale con overlocked=true.
    const portalToken = await portalLogin(owner.slug, email);
    const contracts = await request(app.getHttpServer())
      .get('/portal/me/contracts')
      .set({ Authorization: `Bearer ${portalToken}` });
    expect(contracts.status).toBe(200);
    expect(contracts.body[0]).toMatchObject({ id: contractId, overlocked: true });
  });
});
