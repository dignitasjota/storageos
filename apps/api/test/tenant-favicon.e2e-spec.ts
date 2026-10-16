import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);

describe('Favicon de la web del tenant (e2e)', () => {
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

  async function upload(auth: Record<string, string>, mimeType: string, body: Buffer) {
    const presign = await http()
      .post('/settings/tenant/branding/favicon-upload-url')
      .set(auth)
      .send({ mimeType });
    expect(presign.status).toBe(200);
    const put = await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body,
    });
    expect(put.status).toBe(200);
    return presign.body.key as string;
  }

  it('sube, se ve en la web pública, rechaza ficheros falsos y se quita', async () => {
    const owner = await registerVerifiedUser(app, 'favicon');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin favicon: la web usa el de TrasterOS.
    const brand0 = await http().get(`/public/landing/brand/${owner.slug}`);
    expect(brand0.body.faviconUrl).toBeNull();

    const key = await upload(auth, 'image/png', PNG);
    const set = await http().put('/settings/tenant/branding/favicon').set(auth).send({ key });
    expect(set.status).toBe(200);
    expect(set.body.faviconUrl).toContain(key);
    const brand = await http().get(`/public/landing/brand/${owner.slug}`);
    expect(brand.body.faviconUrl).toContain(key);

    // ICO también vale.
    const icoKey = await upload(auth, 'image/x-icon', ICO);
    expect(icoKey.endsWith('.ico')).toBe(true);
    await http()
      .put('/settings/tenant/branding/favicon')
      .set(auth)
      .send({ key: icoKey })
      .expect(200);

    // Un fichero que no es una imagen PNG se rechaza aunque se pidiera como PNG.
    const fake = await upload(auth, 'image/png', Buffer.from('<svg onload=alert(1)>'));
    const bad = await http().put('/settings/tenant/branding/favicon').set(auth).send({ key: fake });
    expect(bad.status).toBe(400);

    // La clave tiene que ser del propio tenant.
    const other = await registerVerifiedUser(app, 'favicon-b');
    const foreign = await http()
      .put('/settings/tenant/branding/favicon')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send({ key: icoKey });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('invalid_favicon_key');

    // SVG no se admite.
    await http()
      .post('/settings/tenant/branding/favicon-upload-url')
      .set(auth)
      .send({ mimeType: 'image/svg+xml' })
      .expect(400);

    // Quitar.
    const removed = await http()
      .put('/settings/tenant/branding/favicon')
      .set(auth)
      .send({ key: null });
    expect(removed.body.faviconUrl).toBeNull();
  });
});
