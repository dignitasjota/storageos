import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Import units (e2e)', () => {
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

  it('preview resuelve local/tipo por nombre y marca errores', async () => {
    const owner = await registerVerifiedUser(app, 'imp-units-prev');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Centro',
      typeName: 'Mediano',
      unitsCount: 0,
    });

    const csv = [
      'facility,unitType,code,widthM,depthM,heightM',
      'Local Centro,Mediano,A-1,2,2,2',
      'Local Centro,Inexistente,A-2,2,2,2',
      'Otro Local,Mediano,A-3,2,2,2',
    ].join('\n');

    const res = await request(app.getHttpServer())
      .post('/imports/units/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv });

    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ total: 3, valid: 1, invalid: 2, duplicates: 0 });
  });

  it('commit crea trasteros y detecta duplicado por código en re-import', async () => {
    const owner = await registerVerifiedUser(app, 'imp-units-commit');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Único',
      typeName: 'Pequeño',
      unitsCount: 0,
    });

    const csv = 'facility,unitType,code,widthM,depthM,heightM\nLocal Único,Pequeño,Z-1,1,1,2';

    const commit = await request(app.getHttpServer())
      .post('/imports/units/commit')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv, onDuplicate: 'skip' });
    expect(commit.status).toBe(201);
    expect(commit.body.summary).toEqual({ created: 1, skipped: 0, errors: 0 });

    // Re-import: el mismo código en el mismo local es duplicado.
    const preview = await request(app.getHttpServer())
      .post('/imports/units/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv });
    expect(preview.body.summary.duplicates).toBe(1);
    expect(preview.body.summary.valid).toBe(0);
  });
});
