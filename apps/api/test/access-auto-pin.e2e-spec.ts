import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type Cred = { id: string; status: string; method: string };

/**
 * PIN automático al pagar una factura (`invoice_paid` → AccessIntegrationsService):
 * solo para un inquilino con contrato vivo y SIN ningún acceso propio.
 */
describe('Acceso automático al pagar (e2e)', () => {
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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function setup(prefix: string): Promise<{
    auth: Record<string, string>;
    token: string;
    customerId: string;
    email: string;
    contractId: string;
    unitId: string;
    facilityName: string;
    tenantName: string;
  }> {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facilityName = `Local ${prefix}`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      facilityName,
    });
    const email = `${prefix}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const c = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await request(app.getHttpServer()).post(`/contracts/${c.body.id}/sign`).set(auth).expect(200);
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    return {
      auth,
      token: owner.accessToken,
      customerId,
      email,
      contractId: c.body.id as string,
      unitId: unitIds[0]!,
      facilityName,
      tenantName: me.body.tenant.name as string,
    };
  }

  async function creds(auth: Record<string, string>, customerId: string): Promise<Cred[]> {
    const res = await request(app.getHttpServer())
      .get(`/access/credentials?customerId=${customerId}`)
      .set(auth);
    return res.body as Cred[];
  }

  async function waitForCreds(
    auth: Record<string, string>,
    customerId: string,
    pred: (c: Cred[]) => boolean,
  ): Promise<Cred[]> {
    const deadline = Date.now() + 5000;
    let last: Cred[] = [];
    while (Date.now() < deadline) {
      last = await creds(auth, customerId);
      if (pred(last)) return last;
      await sleep(150);
    }
    return last;
  }

  async function payInvoice(token: string, customerId: string): Promise<void> {
    const inv = await createDraftInvoice(app, token, customerId);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
  }

  it('sin acceso propio y con contrato vivo → PIN nuevo con el nombre del tenant, trastero y local', async () => {
    const s = await setup('autopin');
    // El PIN de la firma se revoca → el inquilino se queda sin acceso propio.
    const initial = await waitForCreds(s.auth, s.customerId, (c) => c.length > 0);
    for (const c of initial) {
      await request(app.getHttpServer()).post(`/access/credentials/${c.id}/revoke`).set(s.auth);
    }
    await deleteAllMessages();

    await payInvoice(s.token, s.customerId);
    const after = await waitForCreds(s.auth, s.customerId, (c) =>
      c.some((x) => x.status === 'active'),
    );
    expect(after.filter((c) => c.status === 'active')).toHaveLength(1);

    const mail = await waitForEmail(s.email, { subjectIncludes: 'Tu acceso a' });
    expect(mail.Subject).toBe(`Tu acceso a ${s.tenantName}`);
    const unit = await request(app.getHttpServer()).get(`/units/${s.unitId}`).set(s.auth);
    expect(mail.Text).toContain(`trastero ${unit.body.code as string} en ${s.facilityName}`);
  });

  it('con el acceso suspendido por el staff, pagar NO le da un PIN nuevo', async () => {
    const s = await setup('suspin');
    const initial = await waitForCreds(s.auth, s.customerId, (c) => c.length > 0);
    await request(app.getHttpServer())
      .post(`/access/credentials/${initial[0]!.id}/suspend`)
      .set(s.auth)
      .send({ reason: 'Uso indebido' })
      .expect(200);

    await payInvoice(s.token, s.customerId);
    await sleep(1000);
    const after = await creds(s.auth, s.customerId);
    expect(after).toHaveLength(initial.length);
    expect(after.filter((c) => c.status === 'active')).toHaveLength(0);
  });

  it('un ex-inquilino (sin contratos vivos) que paga una deuda NO recibe acceso', async () => {
    const s = await setup('expin');
    await waitForCreds(s.auth, s.customerId, (c) => c.length > 0);
    await request(app.getHttpServer())
      .post(`/contracts/${s.contractId}/end`)
      .set(s.auth)
      .expect(200);
    await waitForCreds(s.auth, s.customerId, (c) => c.every((x) => x.status === 'revoked'));

    await payInvoice(s.token, s.customerId);
    await sleep(1000);
    const after = await creds(s.auth, s.customerId);
    expect(after.filter((c) => c.status === 'active')).toHaveLength(0);
  });
});
