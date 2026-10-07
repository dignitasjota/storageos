import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Contratos migrados de otro sistema: se importan como borradores y se activan
 * en bloque, sin firma ni avisos, y la recurrente no factura antes del mes
 * indicado.
 */
describe('Activar contratos importados (e2e)', () => {
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

  it('activa en bloque sin avisos, deja la fianza retenida y factura desde el mes indicado', async () => {
    const owner = await registerVerifiedUser(app, 'activateimported');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 50,
    });
    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Migrado',
      lastName: 'Antiguo',
      email: 'migrado@e2e.local',
      country: 'ES',
    });

    const other = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Otro', lastName: 'Cliente', country: 'ES' });
    const create = async (unitId: string, customerId = customer.body.id as string) =>
      (
        await request(app.getHttpServer()).post('/contracts').set(auth).send({
          customerId,
          unitId,
          startDate: '2024-03-15',
          priceMonthly: 50,
          depositAmount: 50,
        })
      ).body.id as string;
    const c1 = await create(unitIds[0]!);
    const c2 = await create(unitIds[1]!);
    // Un tercero ya firmado: no es un borrador y debe fallar sin afectar a los demás.
    const c3 = await create(unitIds[2]!, other.body.id as string);
    await request(app.getHttpServer()).post(`/contracts/${c3}/sign`).set(auth).send({}).expect(200);

    const res = await request(app.getHttpServer())
      .post('/contracts/activate-imported')
      .set(auth)
      .send({ contractIds: [c1, c2, c3], billingStartsOn: '2026-05-01', depositCollected: true });
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].contractId).toBe(c3);

    const detail = await request(app.getHttpServer()).get(`/contracts/${c1}`).set(auth);
    expect(detail.body).toMatchObject({
      status: 'active',
      depositStatus: 'held',
      billingStartsOn: '2026-05-01',
    });
    expect(detail.body.signedAt.slice(0, 10)).toBe('2024-03-15');
    const unit = await admin.unit.findUnique({ where: { id: unitIds[0] } });
    expect(unit?.status).toBe('occupied');

    // Sin avisos al inquilino migrado: ni correos ni PIN de acceso.
    await new Promise((r) => setTimeout(r, 500));
    expect(
      await admin.communication.count({
        where: { tenantId: owner.tenantId, customerId: customer.body.id },
      }),
    ).toBe(0);
    expect(
      await admin.accessCredential.count({
        where: { tenantId: owner.tenantId, customerId: customer.body.id },
      }),
    ).toBe(0);

    const billing = app.get(BillingJobsService);
    // Abril: aún lo facturaba el sistema anterior → nada para los migrados.
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
    });
    expect(
      await admin.invoice.count({ where: { contractId: { in: [c1, c2] }, kind: 'invoice' } }),
    ).toBe(0);
    // Mayo: mes completo.
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    const may = await admin.invoice.findMany({
      where: { contractId: c1, kind: 'invoice' },
      select: { periodStart: true, total: true },
    });
    expect(may).toHaveLength(1);
    expect(may[0]!.periodStart?.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(Number(may[0]!.total)).toBe(60.5);
  });

  it('exige permiso y datos válidos', async () => {
    await request(app.getHttpServer()).post('/contracts/activate-imported').expect(401);
    const owner = await registerVerifiedUser(app, 'activateimported2');
    await request(app.getHttpServer())
      .post('/contracts/activate-imported')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ contractIds: [], billingStartsOn: '2026-05-01' })
      .expect(400);
  });
});
