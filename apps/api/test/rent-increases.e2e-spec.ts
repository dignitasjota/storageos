import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Rent increases / ECRI (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('previsualiza, programa con preaviso y aplica la subida al contrato', async () => {
    const owner = await registerVerifiedUser(app, 'ecri');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato activo a 100€/mes.
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 100,
        depositAmount: 0,
      });
    expect(create.status).toBe(201);
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Preview +10% → 1 afectado, MRR +10, precio nuevo 110.
    const preview = await request(app.getHttpServer())
      .post('/rent-increases/preview')
      .set(auth)
      .send({ increaseType: 'percentage', increaseValue: 10, scope: { minMonthsSinceSigned: 0 } });
    expect(preview.status).toBe(200);
    expect(preview.body.affectedCount).toBe(1);
    expect(preview.body.mrrDelta).toBe(10);
    expect(preview.body.contracts[0].oldPrice).toBe(100);
    expect(preview.body.contracts[0].newPrice).toBe(110);

    // Programar.
    const ri = await request(app.getHttpServer())
      .post('/rent-increases')
      .set(auth)
      .send({
        name: 'Revisión anual +10%',
        increaseType: 'percentage',
        increaseValue: 10,
        scope: { minMonthsSinceSigned: 0 },
        effectiveDate: '2026-06-22',
      });
    expect(ri.status).toBe(201);
    expect(ri.body.status).toBe('scheduled');
    expect(ri.body.affectedCount).toBe(1);
    expect(ri.body.noticeSent).toBe(true);
    expect(ri.body.items).toHaveLength(1);
    const id = ri.body.id as string;

    // El preaviso llegó al outbox.
    const notices = await request(app.getHttpServer())
      .get(`/communications?source=rent_increase:${id}`)
      .set(auth);
    expect(notices.body).toHaveLength(1);
    expect(notices.body[0].channel).toBe('email');

    // Aplicar → contrato pasa a 110€ + evento price_changed.
    const applied = await request(app.getHttpServer())
      .post(`/rent-increases/${id}/apply`)
      .set(auth);
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('applied');
    expect(applied.body.appliedCount).toBe(1);

    const contract = await request(app.getHttpServer()).get(`/contracts/${contractId}`).set(auth);
    expect(contract.body.priceMonthly).toBe(110);

    const events = await request(app.getHttpServer())
      .get(`/contracts/${contractId}/events`)
      .set(auth);
    expect(events.body.some((e: { eventType: string }) => e.eventType === 'price_changed')).toBe(
      true,
    );

    // Reaplicar no duplica (idempotente: ya no quedan items pendientes).
    const reapply = await request(app.getHttpServer())
      .post(`/rent-increases/${id}/apply`)
      .set(auth);
    expect(reapply.status).toBe(200);
    const contract2 = await request(app.getHttpServer()).get(`/contracts/${contractId}`).set(auth);
    expect(contract2.body.priceMonthly).toBe(110);
  });
});
