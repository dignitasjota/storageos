import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Fotos de inspección (check-in / check-out) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sube fotos por kind, lista filtrando, y rechaza keys ajenas', async () => {
    const owner = await registerVerifiedUser(app, 'inspphotos');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Lopez', country: 'ES' });
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId: customer.body.id,
      unitId: unitIds[0]!,
      startDate: '2026-01-01',
      priceMonthly: 80,
      depositAmount: 0,
    });
    const cid = contract.body.id as string;

    async function addPhoto(kind: 'checkin' | 'checkout', note: string): Promise<string> {
      const presign = await request(app.getHttpServer())
        .post(`/contracts/${cid}/inspection-photos/upload-url`)
        .set(auth)
        .send({ kind, mimeType: 'image/jpeg', fileName: `${kind}.jpg` });
      expect(presign.status).toBe(201);
      expect(presign.body.key).toContain(`/contracts/${cid}/${kind}/`);
      const photo = await request(app.getHttpServer())
        .post(`/contracts/${cid}/inspection-photos`)
        .set(auth)
        .send({ kind, key: presign.body.key, note });
      expect(photo.status).toBe(201);
      expect(photo.body.kind).toBe(kind);
      expect(photo.body.url).toContain('http');
      return photo.body.id as string;
    }

    // Una foto de check-in y una de check-out.
    const checkinId = await addPhoto('checkin', 'Trastero vacío a la entrada');
    await addPhoto('checkout', 'Trastero vacío a la salida');

    // La lista filtra por kind.
    const checkins = await request(app.getHttpServer())
      .get(`/contracts/${cid}/inspection-photos?kind=checkin`)
      .set(auth);
    expect(checkins.body).toHaveLength(1);
    expect(checkins.body[0].kind).toBe('checkin');

    const checkouts = await request(app.getHttpServer())
      .get(`/contracts/${cid}/inspection-photos?kind=checkout`)
      .set(auth);
    expect(checkouts.body).toHaveLength(1);
    expect(checkouts.body[0].kind).toBe('checkout');

    // Sin filtro → ambas.
    const all = await request(app.getHttpServer())
      .get(`/contracts/${cid}/inspection-photos`)
      .set(auth);
    expect(all.body).toHaveLength(2);

    // Una key que no pertenece al contrato+kind → 400.
    const bad = await request(app.getHttpServer())
      .post(`/contracts/${cid}/inspection-photos`)
      .set(auth)
      .send({ kind: 'checkin', key: 'otro/contracts/x/checkin/evil.jpg' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_photo_key');

    // Borrar la de check-in → solo queda la de check-out.
    await request(app.getHttpServer())
      .delete(`/contracts/${cid}/inspection-photos/${checkinId}`)
      .set(auth)
      .expect(204);
    const afterCheckins = await request(app.getHttpServer())
      .get(`/contracts/${cid}/inspection-photos?kind=checkin`)
      .set(auth);
    expect(afterCheckins.body).toHaveLength(0);
  });
});
