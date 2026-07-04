import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function dateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Move-out self-service (e2e)', () => {
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

  it('el inquilino lista sus contratos y solicita la baja respetando el preaviso', async () => {
    const owner = await registerVerifiedUser(app, 'moveout');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `moveout-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 80,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Lista de contratos del inquilino.
    const list = await request(app.getHttpServer()).get('/portal/me/contracts').set(pAuth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(contractId);
    expect(list.body[0].status).toBe('active');
    expect(list.body[0].cancellationNoticeDays).toBe(15);

    // Sin token → 401.
    await request(app.getHttpServer()).get('/portal/me/contracts').expect(401);

    // Fecha demasiado pronto (preaviso 15 días) → 400.
    const tooSoon = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/request-move-out`)
      .set(pAuth)
      .send({ endDate: dateInDays(2) });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.code).toBe('notice_period_not_met');

    // Fecha válida → contrato pasa a 'ending' con esa fecha de salida.
    const endDate = dateInDays(30);
    const ok = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/request-move-out`)
      .set(pAuth)
      .send({ endDate });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ending');
    expect(ok.body.endDate).toBe(endDate);

    // Reflejado en el panel del staff.
    const staffView = await request(app.getHttpServer()).get(`/contracts/${contractId}`).set(auth);
    expect(staffView.body.status).toBe('ending');

    // Encuesta de salida disparada (async): se crea una review pending.
    let reviewCount = 0;
    for (let i = 0; i < 40 && reviewCount === 0; i++) {
      const reviews = await request(app.getHttpServer()).get('/reviews').set(auth);
      reviewCount = (reviews.body.items ?? []).length;
      if (reviewCount === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(reviewCount).toBeGreaterThanOrEqual(1);
  });

  it('el inquilino solicita la baja y luego la cancela → el contrato vuelve a active', async () => {
    const owner = await registerVerifiedUser(app, 'moveoutcancel');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `moveout-cancel-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 80,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Solicita la baja.
    const endDate = dateInDays(30);
    const req1 = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/request-move-out`)
      .set(pAuth)
      .send({ endDate });
    expect(req1.status).toBe(200);
    expect(req1.body.status).toBe('ending');

    // Sin token → 401.
    await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/cancel-move-out`)
      .expect(401);

    // Cancela la baja → vuelve a active, sin fecha de salida.
    const cancel = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/cancel-move-out`)
      .set(pAuth);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('active');
    expect(cancel.body.endDate).toBeNull();

    // Un contrato ya activo no se puede «cancelar baja» → 400.
    const again = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/cancel-move-out`)
      .set(pAuth);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('contract_not_ending');

    // Reflejado en el panel del staff.
    const staffView = await request(app.getHttpServer()).get(`/contracts/${contractId}`).set(auth);
    expect(staffView.body.status).toBe('active');
  });

  it('un inquilino no puede solicitar la baja del contrato de otro (404)', async () => {
    const owner = await registerVerifiedUser(app, 'moveout2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const emailA = `mo-a-${Date.now()}@e2e.local`;
    const emailB = `mo-b-${Date.now()}@e2e.local`;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerA = await createCustomer(app, owner.accessToken, { email: emailA });
    await createCustomer(app, owner.accessToken, { email: emailB });

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId: customerA,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 80,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const tokenB = await portalLogin(owner.slug, emailB);
    const res = await request(app.getHttpServer())
      .post(`/portal/me/contracts/${contractId}/request-move-out`)
      .set({ Authorization: `Bearer ${tokenB}` })
      .send({ endDate: dateInDays(30) });
    expect(res.status).toBe(404);
  });
});
