import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Pase nocturno (single-use de pago) (e2e)', () => {
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
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)![1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino compra un pase nocturno gratuito: código single-use', async () => {
    const owner = await registerVerifiedUser(app, 'nightpass');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const email = `np-${Date.now()}@e2e.local`;
    await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Ana',
      lastName: 'Lopez',
      email,
      country: 'ES',
    });
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local NP', country: 'ES' });
    const device = await request(app.getHttpServer()).post('/access/devices').set(auth).send({
      facilityId: facility.body.id,
      type: 'gate',
      name: 'Cancela',
      hardwareId: 'np-dev-1',
    });
    const apiKey = device.body.revealedApiKey as string;

    // El tenant activa el pase nocturno GRATUITO (precio 0). Un pase de pago
    // exige método de cobro (se cobra en el acto, ver portal-night-passes),
    // que no es ejercitable sin pasarela en test; el gratuito valida el
    // single-use del PIN sin depender del cobro.
    const settings = await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 });
    expect(settings.status).toBe(200);
    expect(settings.body.nightPassEnabled).toBe(true);

    const portalToken = await portalLogin(owner.slug, email);
    const phdr = { Authorization: `Bearer ${portalToken}` };

    // Info disponible.
    const info = await request(app.getHttpServer()).get('/portal/me/access/night-pass').set(phdr);
    expect(info.body).toMatchObject({ enabled: true, price: 0 });

    // Compra el pase → código single-use (gratuito: se emite sin cobro).
    const pass = await request(app.getHttpServer()).post('/portal/me/access/night-pass').set(phdr);
    expect(pass.status).toBe(201);
    expect(pass.body.value).toMatch(/^\d{6}$/);
    const pin = pass.body.value as string;

    // Single-use: el primer uso entra, el segundo se rechaza (gastado).
    const first = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: pin, deviceId: 'np-dev-1' });
    expect(first.body.allowed).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: pin, deviceId: 'np-dev-1' });
    expect(second.body.allowed).toBe(false);
  });
});
