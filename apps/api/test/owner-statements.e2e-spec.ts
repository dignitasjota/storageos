import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Plan Administrador: liquidación al propietario por email. */
describe('Liquidaciones al propietario (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('cobrado menos honorarios con IVA y gastos; se guarda y se envía', async () => {
    const user = await registerVerifiedUser(app, 'ownstmt');
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const http = () => request(app.getHttpServer());
    await ensureDefaultSeries(app, user.accessToken);
    await setTenantFeatureOverride(user.slug, 'multi_owner', true);
    const { facilityId, unitIds } = await createFacilityWithUnits(app, user.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const ownerEmail = `propietario-${Date.now()}@example.com`;
    const owner = await http()
      .post('/owners')
      .set(auth)
      .send({
        legalName: 'Inversiones Pérez SL',
        taxId: 'B12345674',
        email: ownerEmail,
        iban: 'ES9121000418450200051332',
        feeType: 'percentage',
        feeValue: 8,
      })
      .expect(201);
    await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ ownerId: owner.body.id })
      .expect(200);
    const customerId = await createCustomer(app, user.accessToken);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 100,
        depositAmount: 0,
      })
      .expect(201);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${draft.body.id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    const today = new Date().toISOString().slice(0, 10);
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        facilityId,
        category: 'maintenance',
        description: 'Cambio de cerradura',
        amount: 50,
        expenseDate: today,
      })
      .expect(201);

    // Periodo amplio para no depender de la zona horaria del día de hoy.
    const period = { from: '2026-01-01', to: '2099-12-31' };
    const preview = await http()
      .get(`/owners/${owner.body.id}/statements/preview`)
      .query(period)
      .set(auth)
      .expect(200);
    expect(preview.body).toMatchObject({
      id: null,
      collected: 121,
      feeBase: 9.68,
      feeVat: 2.03,
      expenses: 50,
      net: 59.29,
      pending: 0,
    });
    expect(preview.body.payments).toHaveLength(1);
    expect(preview.body.expenseLines).toHaveLength(1);

    const saved = await http()
      .post(`/owners/${owner.body.id}/statements`)
      .set(auth)
      .send({ ...period, send: true })
      .expect(201);
    expect(saved.body.id).toEqual(expect.any(String));
    expect(saved.body.sentTo).toBe(ownerEmail);
    const mail = await waitForEmail(ownerEmail, { subjectIncludes: 'Liquidación' });
    expect(mail.Subject).toContain('Liquidación');

    const list = await http().get(`/owners/${owner.body.id}/statements`).set(auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].net).toBe(59.29);

    // Sin email del propietario no se puede enviar (sí guardar).
    const other = await http()
      .post('/owners')
      .set(auth)
      .send({ legalName: 'Otro', taxId: '12345678Z' })
      .expect(201);
    await http()
      .post(`/owners/${other.body.id}/statements`)
      .set(auth)
      .send({ ...period, send: true })
      .expect(400);
    await http()
      .post(`/owners/${other.body.id}/statements`)
      .set(auth)
      .send({ ...period, send: false })
      .expect(201);
  });
});
