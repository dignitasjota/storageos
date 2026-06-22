import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Facility images + slug (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('upload-url + setImages valida la propiedad de la key y construye imageUrls', async () => {
    const owner = await registerVerifiedUser(app, 'fac-img');
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Pedir URL firmada → devuelve una key bajo la carpeta del local.
    const presign = await request(app.getHttpServer())
      .post(`/facilities/${facilityId}/images/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/jpeg', sizeBytes: 12345 });
    expect(presign.status).toBe(200);
    expect(presign.body.uploadUrl).toContain('http');
    const key = presign.body.key as string;
    expect(key).toContain(`/${facilityId}/images/`);

    // Confirmar la imagen (no hace falta subirla físicamente: la API guarda la key).
    const set = await request(app.getHttpServer())
      .put(`/facilities/${facilityId}/images`)
      .set(auth)
      .send({ images: [key] });
    expect(set.status).toBe(200);
    expect(set.body.images).toHaveLength(1);
    expect(set.body.images[0].key).toBe(key);
    expect(set.body.images[0].url).toContain(key);

    // GET refleja la imagen.
    const detail = await request(app.getHttpServer()).get(`/facilities/${facilityId}`).set(auth);
    expect(detail.body.images).toHaveLength(1);

    // Key de otro local/tenant → 404 invalid_image_key.
    const foreign = await request(app.getHttpServer())
      .put(`/facilities/${facilityId}/images`)
      .set(auth)
      .send({ images: ['otrotenant/otrofacility/images/x.jpg'] });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('invalid_image_key');

    // Vaciar la lista.
    const cleared = await request(app.getHttpServer())
      .put(`/facilities/${facilityId}/images`)
      .set(auth)
      .send({ images: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.images).toHaveLength(0);
  });

  it('el slug público se edita vía PATCH /facilities/:id', async () => {
    const owner = await registerVerifiedUser(app, 'fac-slug');
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const patch = await request(app.getHttpServer())
      .patch(`/facilities/${facilityId}`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ publicSlug: 'madrid-centro-test' });
    expect(patch.status).toBe(200);
    expect(patch.body.publicSlug).toBe('madrid-centro-test');
  });
});
