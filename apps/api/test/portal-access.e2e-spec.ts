import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: acceso por QR/PIN (e2e)', () => {
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
    const req = await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email });
    expect(req.status).toBe(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const tokenMatch = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/);
    expect(tokenMatch).toBeTruthy();
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token: tokenMatch![1] });
    expect(consume.status).toBe(200);
    return consume.body.accessToken as string;
  }

  it('el inquilino ve su PIN/QR (descifrado) y puede regenerarlo', async () => {
    const owner = await registerVerifiedUser(app, 'portal-access');
    const email = `pa-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Staff crea una credencial PIN y una QR para el inquilino.
    const pinRes = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId, method: 'pin', pin: '4821', label: 'Puerta principal' });
    expect(pinRes.status).toBe(201);
    expect(pinRes.body.revealedSecret).toBe('4821');

    const qrRes = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId, method: 'qr', label: 'QR móvil' });
    expect(qrRes.status).toBe(201);
    const qrToken = qrRes.body.revealedSecret as string;
    expect(qrToken).toBeTruthy();

    // El inquilino entra a su portal y ve ambas con su valor descifrado.
    const portalToken = await portalLogin(owner.slug, email);
    const list = await request(app.getHttpServer())
      .get('/portal/me/access')
      .set('Authorization', `Bearer ${portalToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const pin = (list.body as { method: string; value: string; id: string }[]).find(
      (c) => c.method === 'pin',
    );
    const qr = (list.body as { method: string; value: string; id: string }[]).find(
      (c) => c.method === 'qr',
    );
    expect(pin?.value).toBe('4821');
    expect(qr?.value).toBe(qrToken);

    // Regenera el PIN: cambia el valor y sigue visible.
    const regen = await request(app.getHttpServer())
      .post(`/portal/me/access/${pin!.id}/regenerate`)
      .set('Authorization', `Bearer ${portalToken}`);
    expect(regen.status).toBe(200);
    expect(regen.body.value).toBeTruthy();
    expect(regen.body.value).not.toBe('4821');
  });

  it('el inquilino crea accesos adicionales hasta el límite del tenant (409 al exceder)', async () => {
    const owner = await registerVerifiedUser(app, 'portal-extra');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `pex-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // El tenant fija el límite de accesos adicionales en 1.
    const setLimit = await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ extraAccessLimit: 1 });
    expect(setLimit.status).toBe(200);
    expect(setLimit.body.extraAccessLimit).toBe(1);

    const portalToken = await portalLogin(owner.slug, email);
    const phdr = { Authorization: `Bearer ${portalToken}` };

    // Primer acceso adicional → OK, devuelve un PIN visible.
    const first = await request(app.getHttpServer())
      .post('/portal/me/access/extra')
      .set(phdr)
      .send({ label: 'Hijo' });
    expect(first.status).toBe(201);
    expect(first.body.method).toBe('pin');
    expect(first.body.value).toBeTruthy();
    expect(first.body.label).toBe('Hijo');

    // Segundo → supera el límite (1) → 409.
    const second = await request(app.getHttpServer())
      .post('/portal/me/access/extra')
      .set(phdr)
      .send({ label: 'Empleado' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('extra_access_limit_reached');

    // Aparece en su lista de accesos.
    const list = await request(app.getHttpServer()).get('/portal/me/access').set(phdr);
    expect(list.body.some((c: { label: string }) => c.label === 'Hijo')).toBe(true);
  });

  it('sin token de portal devuelve 401', async () => {
    const res = await request(app.getHttpServer()).get('/portal/me/access');
    expect(res.status).toBe(401);
  });

  it('no puede regenerar la credencial de otro inquilino (404)', async () => {
    const owner = await registerVerifiedUser(app, 'portal-access-x');
    const emailA = `paa-${Date.now()}@e2e.local`;
    const emailB = `pab-${Date.now()}@e2e.local`;
    const customerA = await createCustomer(app, owner.accessToken, { email: emailA });
    await createCustomer(app, owner.accessToken, { email: emailB });

    const credA = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: customerA, method: 'pin', pin: '1234' });
    expect(credA.status).toBe(201);

    const tokenB = await portalLogin(owner.slug, emailB);
    const res = await request(app.getHttpServer())
      .post(`/portal/me/access/${credA.body.id}/regenerate`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
