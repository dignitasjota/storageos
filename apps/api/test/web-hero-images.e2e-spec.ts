import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('Fotos de la portada de la web del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function upload(
    auth: Record<string, string>,
    slot: 'image' | 'background',
    body: Buffer,
  ): Promise<string> {
    const presign = await http()
      .post('/settings/tenant/web/hero-image-upload-url')
      .set(auth)
      .send({ slot, mimeType: 'image/jpeg' });
    expect(presign.status).toBe(200);
    const put = await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body,
    });
    expect(put.status).toBe(200);
    return presign.body.key as string;
  }

  it('sube la entrada y el fondo, se ven en la web y se quitan', async () => {
    const owner = await registerVerifiedUser(app, 'webhero');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin Web Premium no se puede subir.
    await http()
      .post('/settings/tenant/web/hero-image-upload-url')
      .set(auth)
      .send({ slot: 'image', mimeType: 'image/jpeg' })
      .expect(403);

    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const before = await http().get('/settings/tenant/web').set(auth).expect(200);
    expect(before.body.heroImageUrl).toBeNull();
    expect(before.body.heroBackgroundUrl).toBeNull();

    const imageKey = await upload(auth, 'image', JPEG);
    const bgKey = await upload(auth, 'background', JPEG);
    await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'image', key: imageKey })
      .expect(200);
    const set = await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'background', key: bgKey })
      .expect(200);
    expect(set.body.heroImageUrl).toContain(imageKey);
    expect(set.body.heroBackgroundUrl).toContain(bgKey);

    const landing = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(landing.body.webHeroImageUrl).toContain(imageKey);
    expect(landing.body.webHeroBackgroundUrl).toContain(bgKey);

    // La clave de una foto no vale para el otro hueco ni para otro tenant.
    const swapped = await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'background', key: imageKey });
    expect(swapped.status).toBe(400);
    expect(swapped.body.code).toBe('invalid_hero_image_key');

    // Un fichero que no es una imagen se rechaza aunque se pidiera como JPG.
    const fake = await upload(auth, 'image', Buffer.from('<svg onload=alert(1)>'));
    await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'image', key: fake })
      .expect(400);

    // SVG no se admite.
    await http()
      .post('/settings/tenant/web/hero-image-upload-url')
      .set(auth)
      .send({ slot: 'image', mimeType: 'image/svg+xml' })
      .expect(400);

    // Quitar la de fondo deja la de la entrada.
    const removed = await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'background', key: null })
      .expect(200);
    expect(removed.body.heroBackgroundUrl).toBeNull();
    expect(removed.body.heroImageUrl).toContain(imageKey);

    // Sin Web Premium la web pública no las enseña.
    await setTenantFeatureOverride(owner.slug, 'web_premium', false);
    const plain = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(plain.body.webHeroImageUrl).toBeNull();
  });
});
