import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: documentos del inquilino (KYC) (e2e)', () => {
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

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino sube y ve sus documentos', async () => {
    const owner = await registerVerifiedUser(app, 'pdocs');
    const email = `pdocs-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/portal/me/documents').expect(401);

    // Lista vacía al principio.
    const empty = await request(app.getHttpServer()).get('/portal/me/documents').set(pAuth);
    expect(empty.status).toBe(200);
    expect(empty.body).toHaveLength(0);

    // Pide URL de subida.
    const up = await request(app.getHttpServer())
      .post('/portal/me/documents/upload-url')
      .set(pAuth)
      .send({ type: 'id_front', mimeType: 'image/png', sizeBytes: 2048, fileName: 'dni.png' });
    expect(up.status).toBe(201);
    expect(up.body.uploadUrl).toContain('http');
    expect(up.body.key).toContain('/');

    // Registra el documento (sin subir bytes reales a MinIO).
    const reg = await request(app.getHttpServer()).post('/portal/me/documents').set(pAuth).send({
      type: 'id_front',
      fileUrl: up.body.publicUrl,
      fileName: 'dni.png',
      mimeType: 'image/png',
      fileSize: 2048,
    });
    expect(reg.status).toBe(201);
    expect(reg.body.type).toBe('id_front');
    expect(reg.body.uploadedByName).toBeNull(); // lo subió el inquilino, no el staff

    // Ahora lo ve en su lista.
    const after = await request(app.getHttpServer()).get('/portal/me/documents').set(pAuth);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].fileName).toBe('dni.png');

    // El staff también lo ve en la ficha del cliente.
    const customerId = reg.body.customerId as string;
    const staffList = await request(app.getHttpServer())
      .get(`/customers/${customerId}/documents`)
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(staffList.status).toBe(200);
    expect(staffList.body.some((d: { id: string }) => d.id === reg.body.id)).toBe(true);
  });
});
