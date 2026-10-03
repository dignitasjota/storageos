import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Cobro con tarjeta de los inquilinos desactivado (la cuenta de Stripe es la
 * de la plataforma, sin Stripe Connect): no se registran tarjetas/IBAN por
 * Stripe ni se cobra con ellas; la UI lo sabe por `payment-methods/options`.
 */
describe('Tarjeta de los inquilinos desactivada (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let spy: jest.SpyInstance;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    spy = jest
      .spyOn(app.get(PaymentMethodsService), 'cardPaymentsEnabled', 'get')
      .mockReturnValue(false);
  });

  afterAll(async () => {
    spy.mockRestore();
    await app.close();
    await cleanupTestTenants();
  });

  it('sin alta de tarjeta ni cobro por Stripe; opciones para la UI', async () => {
    const owner = await registerVerifiedUser(app, 'nocard');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const opts = await http().get('/payment-methods/options').set(auth).expect(200);
    expect(opts.body).toEqual({ cardPayments: false });

    const setup = await http()
      .post('/payment-methods/setup-intent')
      .set(auth)
      .send({ customerId })
      .expect(400);
    expect(setup.body.code).toBe('card_payments_disabled');

    // Una tarjeta de Stripe ya guardada tampoco se usa para cobrar.
    await admin.paymentMethod.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        type: 'card',
        gateway: 'stripe',
        gatewayTokenEncrypted: 'x',
        isDefault: true,
      },
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const charge = await http()
      .post(`/payments/invoices/${invoiceId}/charge`)
      .set(auth)
      .send({})
      .expect(400);
    expect(charge.body.code).toBe('card_payments_disabled');
  });
});
