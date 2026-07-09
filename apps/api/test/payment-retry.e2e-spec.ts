import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PaymentRetryService } from '../src/modules/payments/payment-retry.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Reintentos de cobro automático: config + selección/backoff. Sin Stripe en test
 * el cobro real falla, pero el intento se registra (autoRetryCount) y el backoff
 * impide reintentar antes del intervalo.
 */
describe('Reintentos de cobro automático (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('config + selección + backoff', async () => {
    const owner = await registerVerifiedUser(app, 'payretry');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenantId = owner.tenantId;

    // Config: por defecto desactivado; activarlo requiere auto-charge.
    const before = await request(app.getHttpServer()).get('/settings/tenant/billing').set(auth);
    expect(before.body.autoChargeRetryEnabled).toBe(false);
    expect(before.body.autoChargeRetryMax).toBe(3);

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({
        autoChargeOnIssue: true,
        autoChargeRetryEnabled: true,
        autoChargeRetryMax: 2,
        autoChargeRetryIntervalDays: 3,
      });
    expect(patch.status).toBe(200);
    expect(patch.body.autoChargeRetryEnabled).toBe(true);
    expect(patch.body.autoChargeRetryMax).toBe(2);

    // Factura emitida y forzada a `overdue` con un método de pago por defecto.
    const customerId = await createCustomer(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect((r) => [200, 201].includes(r.status));

    const admin = app.get(PrismaAdminService);
    await admin.invoice.update({ where: { id: invoiceId }, data: { status: 'overdue' } });
    await admin.paymentMethod.create({
      data: {
        tenantId,
        customerId,
        type: 'card',
        gateway: 'stripe',
        gatewayTokenEncrypted: 'pm_test',
        last4: '4242',
        isDefault: true,
      },
    });

    // 1er reintento: intenta cobrar (falla sin Stripe) pero cuenta el intento.
    const run1 = await app.get(PaymentRetryService).runRetries();
    expect(run1.attempted).toBeGreaterThanOrEqual(1);
    const after1 = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after1.autoRetryCount).toBe(1);
    expect(after1.autoRetryLastAt).not.toBeNull();

    // 2º reintento inmediato: el backoff (intervalo 3 días) lo excluye.
    const run2 = await app.get(PaymentRetryService).runRetries();
    const after2 = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after2.autoRetryCount).toBe(1);
    expect(run2.attempted).toBe(0);
  });
});
