import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Cambio de trastero (portal → staff) (e2e)', () => {
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

  it('el inquilino solicita el cambio y el staff lo resuelve', async () => {
    const owner = await registerVerifiedUser(app, 'unitchange');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `unitchange-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Sin token → 401.
    await request(app.getHttpServer()).get('/portal/me/unit-change-requests').expect(401);

    // Solicitar (sin contrato concreto).
    const reqRes = await request(app.getHttpServer())
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ note: 'Quiero un trastero más grande, el actual se me ha quedado pequeño.' });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.status).toBe('pending');
    const requestId = reqRes.body.id as string;

    // El inquilino la ve.
    const mine = await request(app.getHttpServer())
      .get('/portal/me/unit-change-requests')
      .set(pAuth);
    expect(mine.body).toHaveLength(1);

    // El staff la ve en la cola.
    const staffList = await request(app.getHttpServer())
      .get('/unit-change-requests?status=pending')
      .set(auth);
    expect(staffList.status).toBe(200);
    expect(staffList.body.some((r: { id: string }) => r.id === requestId)).toBe(true);

    // El staff la resuelve.
    const resolved = await request(app.getHttpServer())
      .patch(`/unit-change-requests/${requestId}`)
      .set(auth)
      .send({ status: 'handled', resolutionNote: 'Le hemos asignado el B-12.' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('handled');

    // Reresolver → 400.
    const again = await request(app.getHttpServer())
      .patch(`/unit-change-requests/${requestId}`)
      .set(auth)
      .send({ status: 'rejected' });
    expect(again.status).toBe(400);

    // Nota demasiado corta → 400.
    const bad = await request(app.getHttpServer())
      .post('/portal/me/unit-change-requests')
      .set(pAuth)
      .send({ note: 'no' });
    expect(bad.status).toBe(400);
  });
});
