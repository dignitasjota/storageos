import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Acceso por reconocimiento facial («tu cara es la llave»), add-on facturable
 * `facial_access` (NO va en ningún plan; solo por add-on/override).
 *  - Sin la feature → 403 aunque el tenant tenga control de accesos (starter).
 *  - Con la feature (override) → crea una credencial `face`, guarda la foto en
 *    MinIO y queda activa.
 */
describe('Acceso facial (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  // 1×1 JPEG (base64) mínimo, suficiente para el flujo (el matching real es del terminal).
  const PHOTO_B64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Q/9k=';

  it('sin la feature facial_access el alta facial da 403', async () => {
    const owner = await registerVerifiedUser(app, 'facial-off');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/access/credentials/face')
      .set(auth)
      .send({ customerId, photoBase64: PHOTO_B64, photoMimeType: 'image/jpeg' });

    expect(res.status).toBe(403);
  });

  it('con la feature facial_access crea una credencial face activa', async () => {
    const owner = await registerVerifiedUser(app, 'facial-on');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    await setTenantFeatureOverride(owner.slug, 'facial_access', true);

    const res = await request(app.getHttpServer())
      .post('/access/credentials/face')
      .set(auth)
      .send({
        customerId,
        label: 'Rostro principal',
        photoBase64: PHOTO_B64,
        photoMimeType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    expect(res.body.method).toBe('face');
    expect(res.body.status).toBe('active');
    expect(res.body.label).toBe('Rostro principal');
    expect(res.body.customerId).toBe(customerId);

    // Aparece en el listado filtrando por método facial.
    const list = await request(app.getHttpServer())
      .get('/access/credentials?method=face')
      .set(auth);
    expect(list.status).toBe(200);
    expect(list.body.some((c: { id: string }) => c.id === res.body.id)).toBe(true);
  });

  it('exige autenticación', async () => {
    const res = await request(app.getHttpServer())
      .post('/access/credentials/face')
      .send({ customerId: '00000000-0000-0000-0000-000000000000', photoBase64: 'x' });
    expect(res.status).toBe(401);
  });
});
