import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

describe('Logo del tenant subido como fichero (e2e)', () => {
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
      .post('/settings/tenant/branding/logo-upload-url')
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

  it('sube el logo, lo usa la web, rechaza ficheros falsos y se quita', async () => {
    const owner = await registerVerifiedUser(app, 'logoup');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const key = await upload(auth, 'image/png', PNG);
    const set = await http().put('/settings/tenant/branding/logo').set(auth).send({ key });
    expect(set.status).toBe(200);
    expect(set.body.logoUploaded).toBe(true);
    expect(set.body.portalLogoUrl).toContain(key);
    const brand = await http().get(`/public/landing/brand/${owner.slug}`);
    expect(brand.body.logoUrl).toContain(key);
    expect(brand.body.logoUploaded).toBe(true);

    // Los bytes del logo subido, para el icono de la app.
    const bytes = await http().get(`/public/landing/brand/${owner.slug}/logo`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(bytes.body as Buffer, PNG)).toBe(0);

    // Guardar el resto de la marca sin tocar el logo no lo convierte en dirección pegada.
    const same = await http()
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '#ff6600', portalLogoUrl: set.body.portalLogoUrl });
    expect(same.body.logoUploaded).toBe(true);

    // JPG también vale.
    const jpg = await upload(auth, 'image/jpeg', JPG);
    expect(jpg.endsWith('.jpg')).toBe(true);
    await http().put('/settings/tenant/branding/logo').set(auth).send({ key: jpg }).expect(200);

    // Un fichero que no es la imagen declarada se rechaza.
    const fake = await upload(auth, 'image/png', Buffer.from('<svg onload=alert(1)>'));
    await http().put('/settings/tenant/branding/logo').set(auth).send({ key: fake }).expect(400);

    // La clave tiene que ser del propio tenant.
    const other = await registerVerifiedUser(app, 'logoup-b');
    const foreign = await http()
      .put('/settings/tenant/branding/logo')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send({ key: jpg });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('invalid_logo_key');

    // Ni SVG ni WebP.
    for (const mimeType of ['image/svg+xml', 'image/webp']) {
      await http()
        .post('/settings/tenant/branding/logo-upload-url')
        .set(auth)
        .send({ mimeType })
        .expect(400);
    }

    // Quitar.
    const removed = await http()
      .put('/settings/tenant/branding/logo')
      .set(auth)
      .send({ key: null });
    expect(removed.body.logoUploaded).toBe(false);
    expect(removed.body.portalLogoUrl).toBeNull();
    await http().get(`/public/landing/brand/${owner.slug}/logo`).expect(404);
  });
});
