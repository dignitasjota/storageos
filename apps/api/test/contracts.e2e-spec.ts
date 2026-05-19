import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function createDraftContract(
  app: INestApplication,
  accessToken: string,
  unitId: string,
  customerId: string,
  overrides: Partial<{ priceMonthly: number; discountAmount: number; startDate: string }> = {},
): Promise<{ id: string; contractNumber: string }> {
  const res = await request(app.getHttpServer())
    .post('/contracts')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      customerId,
      unitId,
      startDate: overrides.startDate ?? '2026-06-01',
      priceMonthly: overrides.priceMonthly ?? 80,
      discountAmount: overrides.discountAmount ?? 0,
      depositAmount: 100,
    });
  if (res.status !== 201) {
    throw new Error(`contract create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id as string, contractNumber: res.body.contractNumber as string };
}

describe('Contracts state machine + sync units (e2e)', () => {
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

  it('crea contrato draft con numero secuencial; effectivePrice respeta descuento', async () => {
    const owner = await registerVerifiedUser(app, 'ct-create');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const c = await createDraftContract(app, owner.accessToken, unitIds[0]!, customerId, {
      priceMonthly: 100,
      discountAmount: 15,
    });
    expect(c.contractNumber).toMatch(/^CT-\d{4}-00001$/);

    const detail = await request(app.getHttpServer())
      .get(`/contracts/${c.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('draft');
    expect(detail.body.priceMonthly).toBe(100);
    expect(detail.body.discountAmount).toBe(15);
    expect(detail.body.effectivePrice).toBe(85);

    // Eventos: 1 'created'
    const events = await request(app.getHttpServer())
      .get(`/contracts/${c.id}/events`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(events.body).toHaveLength(1);
    expect(events.body[0].eventType).toBe('created');
  });

  it('flujo completo: sign -> request-end -> end + sync units', async () => {
    const owner = await registerVerifiedUser(app, 'ct-flow');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await createDraftContract(app, owner.accessToken, unitId, customerId);

    // Sign -> active + unit occupied
    const signed = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('active');
    expect(signed.body.signedAt).toBeTruthy();

    const unitAfterSign = await request(app.getHttpServer())
      .get(`/units/${unitId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unitAfterSign.body.status).toBe('occupied');

    // request-end -> ending
    const ending = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/request-end`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ending.status).toBe(200);
    expect(ending.body.status).toBe('ending');

    // end -> ended + unit available
    const ended = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/end`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
    const unitAfterEnd = await request(app.getHttpServer())
      .get(`/units/${unitId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unitAfterEnd.body.status).toBe('available');

    // History de unit: available -> occupied -> available
    const hist = await request(app.getHttpServer())
      .get(`/units/${unitId}/history`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].newStatus).toBe('available');
    expect(hist.body[1].newStatus).toBe('occupied');
  });

  it('transicion invalida: ended -> active devuelve 400', async () => {
    const owner = await registerVerifiedUser(app, 'ct-bad-trans');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await createDraftContract(app, owner.accessToken, unitIds[0]!, customerId);
    await request(app.getHttpServer())
      .post(`/contracts/${c.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    await request(app.getHttpServer())
      .post(`/contracts/${c.id}/end`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const res = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_contract_transition');
  });

  it('change-price crea evento price_changed', async () => {
    const owner = await registerVerifiedUser(app, 'ct-price');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await createDraftContract(app, owner.accessToken, unitIds[0]!, customerId);
    await request(app.getHttpServer())
      .post(`/contracts/${c.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const change = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/change-price`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ priceMonthly: 120, reason: 'Revision anual' });
    expect(change.status).toBe(200);
    expect(change.body.priceMonthly).toBe(120);

    const events = await request(app.getHttpServer())
      .get(`/contracts/${c.id}/events`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const priceEv = events.body.find((e: { eventType: string }) => e.eventType === 'price_changed');
    expect(priceEv).toBeDefined();
    expect(priceEv.payload.from).toBe(80);
    expect(priceEv.payload.to).toBe(120);
    expect(priceEv.payload.reason).toBe('Revision anual');
  });

  it('cancel desde activo libera el unit', async () => {
    const owner = await registerVerifiedUser(app, 'ct-cancel');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await createDraftContract(app, owner.accessToken, unitId, customerId);
    await request(app.getHttpServer())
      .post(`/contracts/${c.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const cancel = await request(app.getHttpServer())
      .post(`/contracts/${c.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'No interesa' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    const unit = await request(app.getHttpServer())
      .get(`/units/${unitId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unit.body.status).toBe('available');
  });

  it('sign sobre unit occupied devuelve 409', async () => {
    const owner = await registerVerifiedUser(app, 'ct-occ');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const customerA = await createCustomer(app, owner.accessToken);
    const customerB = await createCustomer(app, owner.accessToken);
    // Firma contrato A (unit -> occupied)
    const a = await createDraftContract(app, owner.accessToken, unitId, customerA);
    await request(app.getHttpServer())
      .post(`/contracts/${a.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    // Intenta firmar contrato B con mismo unit
    const b = await createDraftContract(app, owner.accessToken, unitId, customerB);
    const res = await request(app.getHttpServer())
      .post(`/contracts/${b.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('unit_not_available');
  });
});
