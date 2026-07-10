import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function eventually<T>(fn: () => Promise<T>, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Correcciones de control de accesos (auditoría 2026-07-10):
 *  - BUG-1: las credenciales auto-emitidas se acotan al local/trastero del
 *    contrato (antes daban acceso a TODO el tenant).
 *  - BUG-3: los pases single-use se reservan de forma atómica (dos verify
 *    concurrentes con el mismo PIN → solo uno abre).
 */
describe('Fixes de control de accesos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('BUG-1: el PIN auto-emitido al firmar se acota al local y trastero del contrato', async () => {
    const owner = await registerVerifiedUser(app, 'acc-scope');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .expect(200);

    // El listener contract_signed emite la credencial de forma asíncrona.
    const cred = await eventually(async () => {
      const list = await request(app.getHttpServer())
        .get(`/access/credentials?customerId=${customerId}`)
        .set(auth);
      return (
        (list.body as { allowedFacilityIds: string[]; method: string }[]).find(
          (c) => c.method === 'pin' && c.allowedFacilityIds.length > 0,
        ) ?? null
      );
    });
    expect(cred).toBeTruthy();
    expect(cred!.allowedFacilityIds).toEqual([facilityId]);
    expect((cred as unknown as { allowedUnitIds: string[] }).allowedUnitIds).toEqual([unitIds[0]]);
  });

  it('BUG-3: dos verify concurrentes de un pase single-use → solo uno abre', async () => {
    const owner = await registerVerifiedUser(app, 'acc-race');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const email = `race-${Date.now()}@e2e.local`;
    await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Race',
        lastName: 'Test',
        email,
        country: 'ES',
      });
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Race', country: 'ES' });
    const device = await request(app.getHttpServer()).post('/access/devices').set(auth).send({
      facilityId: facility.body.id,
      type: 'gate',
      name: 'Cancela',
      hardwareId: 'race-dev-1',
    });
    const apiKey = device.body.revealedApiKey as string;
    await request(app.getHttpServer())
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);

    // Login del portal + compra del pase (gratuito → single-use sin cobro).
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)![1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const phdr = { Authorization: `Bearer ${consume.body.accessToken}` };
    const pass = await request(app.getHttpServer()).post('/portal/me/access/night-pass').set(phdr);
    const pin = pass.body.value as string;

    // Dos verify EN PARALELO con el mismo PIN de 1 uso.
    const body = { method: 'pin', credential: pin, deviceId: 'race-dev-1' };
    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post('/access/verify').set('X-Device-Key', apiKey).send(body),
      request(app.getHttpServer()).post('/access/verify').set('X-Device-Key', apiKey).send(body),
    ]);
    const allowedCount = [a.body.allowed, b.body.allowed].filter((x) => x === true).length;
    expect(allowedCount).toBe(1);
  });
});
