import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Facturación en lote (cierre mensual) + emisión automática opt-in.
 */
describe('Facturación en lote + auto-issue (e2e)', () => {
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

  it('bulk/issue emite N borradores y reporta los fallos por separado', async () => {
    const owner = await registerVerifiedUser(app, 'bulk-issue');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const a = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    const b = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 60 });

    // Emitir b ANTES para que en el lote salga como fallo (ya no es draft).
    await request(app.getHttpServer()).post(`/invoices/${b}/issue`).set(auth).expect(200);

    const res = await request(app.getHttpServer())
      .post('/invoices/bulk/issue')
      .set(auth)
      .send({ ids: [a, b] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toContain(a);
    expect(res.body.failed.map((f: { id: string }) => f.id)).toContain(b);

    // `a` quedó emitida.
    const detail = await request(app.getHttpServer()).get(`/invoices/${a}`).set(auth);
    expect(detail.body.status).toBe('issued');
  });

  it('con auto_issue_recurring activo, la recurrente emite en vez de dejar draft', async () => {
    const owner = await registerVerifiedUser(app, 'bulk-autoissue');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-06-01',
      priceMonthly: 80,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Activar la emisión automática.
    await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ autoIssueRecurring: true })
      .expect(200);

    const billing = app.get(BillingJobsService);
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });

    const invoices = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    const list = invoices.body.items ?? invoices.body;
    expect(list.length).toBe(1);
    // Se emitió sola (no quedó en draft).
    expect(list[0].status).toBe('issued');
  });
});
