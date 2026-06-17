import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function createUnitWithCode(
  app: INestApplication,
  token: string,
  facilityId: string,
  unitTypeId: string,
  code: string,
): Promise<void> {
  const res = await request(app.getHttpServer())
    .post('/units')
    .set('Authorization', `Bearer ${token}`)
    .send({ facilityId, unitTypeId, code, widthM: 2, depthM: 2, heightM: 2.5 });
  if (res.status !== 201) {
    throw new Error(`unit create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

describe('Import contracts (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('preview resuelve inquilino+trastero y marca errores', async () => {
    const owner = await registerVerifiedUser(app, 'imp-contr-prev');
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 0,
    });
    await createUnitWithCode(app, owner.accessToken, facilityId, unitTypeId, 'C-1');
    await createCustomer(app, owner.accessToken, { email: 'tenant@import.local' });

    const csv = [
      'customerEmail,unitCode,startDate,priceMonthly',
      'tenant@import.local,C-1,2026-01-01,75',
      'nope@import.local,C-1,2026-01-01,75',
      'tenant@import.local,NO-EXISTE,2026-01-01,75',
    ].join('\n');

    const res = await request(app.getHttpServer())
      .post('/imports/contracts/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv });

    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ total: 3, valid: 1, invalid: 2, duplicates: 0 });
  });

  it('commit crea el contrato (borrador)', async () => {
    const owner = await registerVerifiedUser(app, 'imp-contr-commit');
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 0,
    });
    await createUnitWithCode(app, owner.accessToken, facilityId, unitTypeId, 'C-9');
    await createCustomer(app, owner.accessToken, { email: 'firma@import.local' });

    const csv =
      'customerEmail,unitCode,startDate,priceMonthly\nfirma@import.local,C-9,2026-02-01,90';

    const commit = await request(app.getHttpServer())
      .post('/imports/contracts/commit')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv, onDuplicate: 'skip' });
    expect(commit.status).toBe(201);
    expect(commit.body.summary).toEqual({ created: 1, skipped: 0, errors: 0 });

    const list = await request(app.getHttpServer())
      .get('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body.some((c: { status: string }) => c.status === 'draft')).toBe(true);
  });
});
