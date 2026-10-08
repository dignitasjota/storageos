import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Plan Administrador: liquidación al propietario por email. */
describe('Liquidaciones al propietario (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
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

    // Ese cobro lo devuelve el banco dos meses después: se descuenta en la
    // liquidación del mes de la devolución (el propietario ya lo había cobrado).
    await admin.payment.updateMany({
      where: { invoiceId: draft.body.id, methodType: 'cash' },
      data: {
        status: 'failed',
        paidAt: new Date('2026-01-15T10:00:00Z'),
        returnedAt: new Date('2026-03-10T10:00:00Z'),
      },
    });
    const march = await http()
      .get(`/owners/${owner.body.id}/statements/preview`)
      .query({ from: '2026-03-01', to: '2026-03-31' })
      .set(auth)
      .expect(200);
    expect(march.body).toMatchObject({ collected: 0, refunded: 121 });

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
