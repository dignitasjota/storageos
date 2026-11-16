import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Fianzas tras la respuesta de la asesoría: la parte retenida que paga un
 * servicio (limpieza, vaciado…) se factura con IVA y se paga con la fianza;
 * cada negocio decide si deposita también las fianzas de los trasteros.
 */
describe('Fianza: factura del servicio y depósito de trasteros (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function contractWithDeposit(
    accessToken: string,
    unitId: string,
    deposit: number,
  ): Promise<string> {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const customerId = await createCustomer(app, accessToken);
    const created = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: '2026-05-01',
        priceMonthly: 60,
        depositAmount: deposit,
      })
      .expect(201);
    const id = created.body.id as string;
    await http().post(`/contracts/${id}/sign`).set(auth).expect(200);
    await http()
      .post(`/contracts/${id}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    return id;
  }

  it('el servicio pagado con la fianza lleva su factura con IVA', async () => {
    const owner = await registerVerifiedUser(app, 'depsrv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const contractId = await contractWithDeposit(owner.accessToken, unitIds[0]!, 100);
    const invoicesBefore = await http().get(`/invoices?contractId=${contractId}`).set(auth);
    const countBefore = (invoicesBefore.body as unknown[]).length;

    // El servicio no puede pasar de lo que se retiene; no deja factura.
    const tooHigh = await http()
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({
        returnedAmount: 50,
        serviceCharge: { description: 'Limpieza del trastero', amount: 60 },
      })
      .expect(400);
    expect(tooHigh.body.code).toBe('service_charge_too_high');
    const invoicesAfterError = await http().get(`/invoices?contractId=${contractId}`).set(auth);
    expect((invoicesAfterError.body as unknown[]).length).toBe(countBefore);

    // Devuelve 20; de los 80 retenidos, 60 son la limpieza y 20 daños.
    const settled = await http()
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({
        returnedAmount: 20,
        retentionReason: 'Daños en la puerta',
        serviceCharge: { description: 'Limpieza del trastero', amount: 60 },
      })
      .expect(200);
    expect(settled.body).toMatchObject({
      depositStatus: 'partially_returned',
      depositReturnedAmount: 20,
      depositRetentionReason: 'Daños en la puerta',
    });
    const service = settled.body.depositServiceInvoice as {
      id: string;
      number: string;
      total: number;
    };
    expect(service.number).toBeTruthy();
    expect(service.total).toBe(60);

    const invoice = await http().get(`/invoices/${service.id}`).set(auth).expect(200);
    expect(invoice.body).toMatchObject({
      status: 'paid',
      invoiceType: 'F1',
      contractId,
      total: 60,
      amountPaid: 60,
    });
    expect(invoice.body.items).toHaveLength(1);
    expect(invoice.body.items[0]).toMatchObject({
      description: 'Limpieza del trastero',
      taxRate: 21,
    });
    expect(invoice.body.taxAmount).toBeCloseTo(10.41, 2);

    // En el historial del contrato.
    const events = await http().get(`/contracts/${contractId}/events`).set(auth).expect(200);
    const event = (events.body as { payload: Record<string, unknown> }[]).find(
      (e) => e.payload?.event === 'deposit_settled',
    );
    expect(event?.payload).toMatchObject({
      serviceInvoiceNumber: service.number,
      serviceAmount: 60,
    });

    // Solo el servicio: su descripción vale de motivo.
    const other = await contractWithDeposit(owner.accessToken, unitIds[1]!, 50);
    const onlyService = await http()
      .post(`/contracts/${other}/settle-deposit`)
      .set(auth)
      .send({
        returnedAmount: 0,
        serviceCharge: { description: 'Vaciado del trastero', amount: 50 },
      })
      .expect(200);
    expect(onlyService.body).toMatchObject({
      depositStatus: 'partially_returned',
      depositRetentionReason: 'Vaciado del trastero',
      depositServiceInvoice: { total: 50 },
    });
  });

  it('las fianzas de trasteros se depositan solo si el negocio lo activa', async () => {
    const owner = await registerVerifiedUser(app, 'depreg');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const contractId = await contractWithDeposit(owner.accessToken, unitIds[0]!, 80);

    const off = await http()
      .put(`/contracts/${contractId}/deposit-registry`)
      .set(auth)
      .send({ body: 'Generalitat Valenciana', registeredAt: '2026-05-10' })
      .expect(400);
    expect(off.body.code).toBe('not_housing');
    expect((await http().get('/dashboard/today').set(auth)).body.depositsToRegister.count).toBe(0);

    const template = await http()
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ depositRegistryStorage: true })
      .expect(200);
    expect(template.body.depositRegistryStorage).toBe(true);

    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.depositsToRegister.count).toBe(1);
    expect(today.body.depositsToRegister.items[0].id).toBe(contractId);

    const saved = await http()
      .put(`/contracts/${contractId}/deposit-registry`)
      .set(auth)
      .send({ body: 'Generalitat Valenciana', registeredAt: '2026-05-10', reference: 'F-123' })
      .expect(200);
    expect(saved.body.depositRegistry).toMatchObject({
      body: 'Generalitat Valenciana',
      registeredAt: '2026-05-10',
      reference: 'F-123',
    });
    expect((await http().get('/dashboard/today').set(auth)).body.depositsToRegister.count).toBe(0);
  });
});
