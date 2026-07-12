import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * «Tu móvil es la llave»: el inquilino abre la puerta de su local desde el
 * portal. Reusa el pipeline de accesos (credencial activa + LockProvider stub).
 */
describe('Portal: abrir puerta desde el móvil (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
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

  it('lista la puerta de su local y la abre', async () => {
    const owner = await registerVerifiedUser(app, 'door');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 60,
    });
    const email = `door-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Contrato activo en el local.
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 60 });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({})
      .expect(200);

    // Dispositivo (puerta) del local.
    const device = await request(app.getHttpServer())
      .post('/access/devices')
      .set(auth)
      .send({
        facilityId,
        type: 'gate',
        name: 'Puerta principal',
        hardwareId: `door-hw-${Date.now()}`,
      });
    expect(device.status).toBe(201);
    const deviceId = device.body.id as string;

    // Credencial de acceso activa del inquilino.
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin' });
    expect(cred.status).toBe(201);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // El inquilino ve la puerta de su local.
    const doors = await request(app.getHttpServer()).get('/portal/me/doors').set(pAuth);
    expect(doors.status).toBe(200);
    expect(doors.body.map((d: { id: string }) => d.id)).toContain(deviceId);

    // La abre → dispatched (LockProvider stub).
    const open = await request(app.getHttpServer())
      .post(`/portal/me/doors/${deviceId}/open`)
      .set(pAuth);
    expect(open.status).toBe(201);
    expect(open.body.opened).toBe(true);

    // Queda registrado en el histórico de accesos del inquilino.
    const logs = await request(app.getHttpServer()).get('/portal/me/access-logs').set(pAuth);
    expect(logs.body.length).toBeGreaterThanOrEqual(1);
  });

  it('sin sesión de portal → 401', async () => {
    await request(app.getHttpServer()).get('/portal/me/doors').expect(401);
  });
});
