import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Check-out con fotos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sube, lista y borra fotos de check-out; rechaza keys ajenas', async () => {
    const owner = await registerVerifiedUser(app, 'checkout');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Lopez', country: 'ES' });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId: customer.body.id,
        unitId: unitIds[0]!,
        startDate: '2026-01-01',
        priceMonthly: 80,
        depositAmount: 0,
      });
    const cid = contract.body.id as string;

    // 1. Pide URL firmada de subida → devuelve una key del propio contrato.
    const presign = await request(app.getHttpServer())
      .post(`/contracts/${cid}/checkout-photos/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/jpeg', fileName: 'salida.jpg' });
    expect(presign.status).toBe(201);
    expect(presign.body.uploadUrl).toContain('http');
    expect(presign.body.key).toContain(`/contracts/${cid}/checkout/`);

    // 2. Registra la foto con esa key (en un flujo real, el navegador hace el PUT antes).
    const photo = await request(app.getHttpServer())
      .post(`/contracts/${cid}/checkout-photos`)
      .set(auth)
      .send({ key: presign.body.key, note: 'Trastero vacío y limpio' });
    expect(photo.status).toBe(201);
    expect(photo.body.url).toContain('http');
    expect(photo.body.note).toBe('Trastero vacío y limpio');

    // 3. Aparece en la lista (con URL firmada GET).
    const list = await request(app.getHttpServer())
      .get(`/contracts/${cid}/checkout-photos`)
      .set(auth);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].url).toContain('http');

    // 4. Una key que no pertenece al contrato → 400.
    const bad = await request(app.getHttpServer())
      .post(`/contracts/${cid}/checkout-photos`)
      .set(auth)
      .send({ key: 'otro-tenant/contracts/x/checkout/evil.jpg' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_photo_key');

    // 5. Borrar → desaparece.
    await request(app.getHttpServer())
      .delete(`/contracts/${cid}/checkout-photos/${photo.body.id}`)
      .set(auth)
      .expect(204);
    const after = await request(app.getHttpServer())
      .get(`/contracts/${cid}/checkout-photos`)
      .set(auth);
    expect(after.body).toHaveLength(0);
  });
});
