import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * #4 + #5 de la 2ª auditoría:
 *  - Al finalizar un contrato se cancela el dunning `scheduled` de sus facturas.
 *  - Una fianza retenida (`held`) sin liquidar de un contrato finalizado aparece
 *    en la bandeja «Hoy» (depositsToSettle).
 */
describe('Cierre de contrato: cancela dunning + alerta de fianza sin liquidar (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('finalizar el contrato cancela su dunning programado y deja la fianza held visible en «Hoy»', async () => {
    const owner = await registerVerifiedUser(app, 'endcleanup');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);

    // Contrato con fianza de 100 € → firmar → fianza `held`.
    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 100,
    });
    expect(create.status).toBe(201);
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Factura del contrato + una acción de dunning `scheduled` sobre ella.
    const inv = await request(app.getHttpServer())
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 60, taxRate: 21 }],
      });
    expect(inv.status).toBe(201);
    const invoiceId = inv.body.id as string;

    const dunning = await adminClient.dunningAction.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        actionType: 'email_reminder',
        status: 'scheduled',
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });

    // Finalizar el contrato.
    await request(app.getHttpServer()).post(`/contracts/${contractId}/end`).set(auth).expect(200);

    // #4: el dunning programado quedó cancelado.
    const after = await adminClient.dunningAction.findUnique({ where: { id: dunning.id } });
    expect(after?.status).toBe('cancelled');

    // #5: la fianza sigue `held` (no se liquidó) → aparece en «Hoy».
    const today = await request(app.getHttpServer()).get('/dashboard/today').set(auth).expect(200);
    expect(today.body.depositsToSettle.count).toBeGreaterThanOrEqual(1);
    expect(today.body.depositsToSettle.items.some((i: { id: string }) => i.id === contractId)).toBe(
      true,
    );
    expect(today.body.urgentCount).toBeGreaterThanOrEqual(1);
  });
});
