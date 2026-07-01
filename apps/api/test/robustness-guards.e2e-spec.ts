import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { claimDailyCronRun } from '../src/common/cron-claim';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

/**
 * Guardas de robustez contra ejecuciones concurrentes:
 *  - claim diario de crons (`cron_runs`): solo una réplica gana.
 *  - índice único parcial de acciones de dunning activas.
 *  - índice único parcial de la factura recurrente (existencia + predicado).
 */
describe('Guardas de robustez (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let prisma: PrismaClient;
  let tenantId: string;
  let auth: { Authorization: string };

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const owner = await registerVerifiedUser(app, 'guards');
    tenantId = owner.tenantId;
    auth = { Authorization: `Bearer ${owner.accessToken}` };
    // Limpia claims de runs anteriores del test (tabla global).
    await prisma.cronRun.deleteMany({ where: { name: { startsWith: 'test-guards' } } });
  });

  afterAll(async () => {
    await prisma.cronRun.deleteMany({ where: { name: { startsWith: 'test-guards' } } });
    await prisma.$disconnect();
    await app.close();
    await cleanupTestTenants();
  });

  it('claimDailyCronRun: la primera réplica gana, la segunda se salta', async () => {
    const first = await claimDailyCronRun(admin, 'test-guards.daily');
    const second = await claimDailyCronRun(admin, 'test-guards.daily');
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Otro cron (nombre distinto) no se ve afectado.
    expect(await claimDailyCronRun(admin, 'test-guards.other')).toBe(true);
  });

  it('dunning_actions: no permite duplicar una acción activa (índice parcial)', async () => {
    const customerId = await createCustomer(app, auth.Authorization.slice(7));
    const invoiceId = await createDraftInvoice(app, auth.Authorization.slice(7), customerId);

    const data = {
      tenantId,
      invoiceId,
      actionType: 'email_reminder' as const,
      status: 'scheduled' as const,
      scheduledFor: new Date(),
    };
    await prisma.dunningAction.create({ data });
    await expect(prisma.dunningAction.create({ data })).rejects.toMatchObject({ code: 'P2002' });

    // Una acción CANCELADA del mismo tipo sí convive (predicado del índice).
    await prisma.dunningAction.updateMany({
      where: { tenantId, invoiceId },
      data: { status: 'cancelled' },
    });
    await expect(prisma.dunningAction.create({ data })).resolves.toBeTruthy();
  });

  it('invoices: existe el índice único parcial anti-duplicado de la recurrente', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'invoices_recurring_period_unique'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toContain('UNIQUE');
    expect(def).toContain('contract_id');
    expect(def).toContain('period_start');
    expect(def).toContain("'F1'");
  });

  it('dos borradores de la misma serie conviven (bug latente del unique de secuencia)', async () => {
    // Antes, el unique (tenant, series, sequence_number) con drafts a 0 solo
    // permitía UN borrador por serie → la recurrente con 2+ contratos fallaba.
    const customerId = await createCustomer(app, auth.Authorization.slice(7));
    const d1 = await createDraftInvoice(app, auth.Authorization.slice(7), customerId);
    const d2 = await createDraftInvoice(app, auth.Authorization.slice(7), customerId);
    expect(d1).toBeTruthy();
    expect(d2).toBeTruthy();
    expect(d1).not.toBe(d2);
  });

  it('crear una factura duplicada del mismo contrato+periodo da 409', async () => {
    const { unitIds } = await createFacilityWithUnits(app, auth.Authorization.slice(7), {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, auth.Authorization.slice(7));
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-07-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    expect(contract.status).toBe(201);

    const invoiceInput = {
      customerId,
      contractId: contract.body.id,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
    };
    await request(app.getHttpServer()).post('/invoices').set(auth).send(invoiceInput).expect(201);
    // El índice parcial corta la segunda → 409 legible (no un 500).
    const dup = await request(app.getHttpServer()).post('/invoices').set(auth).send(invoiceInput);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate_period_invoice');
  });
});
