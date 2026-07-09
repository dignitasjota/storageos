import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Reconciliación de inventario: detecta trasteros cuyo estado no cuadra con sus
 * contratos (ocupado sin contrato vivo, etc.).
 */
describe('Reconciliación de inventario (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('detecta un trastero ocupado sin contrato vivo', async () => {
    const owner = await registerVerifiedUser(app, 'inventory');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });

    // Sin descuadres al principio.
    const before = await request(app.getHttpServer()).get('/inventory/issues').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(0);

    // Forzamos un trastero a `occupied` sin ningún contrato → estado imposible.
    const admin = app.get(PrismaAdminService);
    await admin.unit.update({ where: { id: unitIds[0] }, data: { status: 'occupied' } });

    const after = await request(app.getHttpServer()).get('/inventory/issues').set(auth);
    expect(after.status).toBe(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].unitId).toBe(unitIds[0]);
    expect(after.body[0].currentStatus).toBe('occupied');
    expect(after.body[0].expectedStatus).toBe('available');
  });
});
