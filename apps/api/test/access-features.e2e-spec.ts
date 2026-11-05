import request from 'supertest';

import { AccessDevicesService } from '../src/modules/access/access-devices.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { dunningCalendar } from '../src/modules/dunning/dunning-calendar';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Mejoras de accesos', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await cleanupTestTenants();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function customerWithUnit(token: string) {
    const email = `accf-${Math.random().toString(36).slice(2, 10)}@e2e.local`;
    const id = await createCustomer(app, token, { email });
    return { id, email, ...(await signedContractFor(app, token, { id })) };
  }

  async function device(token: string, facilityId: string, extra: object = {}) {
    const res = await http()
      .post('/access/devices')
      .set(auth(token))
      .send({
        facilityId,
        type: 'door',
        name: 'Puerta',
        hardwareId: `hw-${Math.random().toString(36).slice(2, 10)}`,
        provider: 'stub',
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; revealedApiKey: string; hardwareId: string };
  }

  const verify = (dev: { revealedApiKey: string; hardwareId: string }, credential: string) =>
    http()
      .post('/access/verify')
      .set('X-Device-Key', dev.revealedApiKey)
      .send({ method: 'pin', credential, deviceId: dev.hardwareId });

  it('la ficha del inquilino lo reúne todo y se corta o reactiva de una vez', async () => {
    const owner = await registerVerifiedUser(app, 'accfsum');
    const c = await customerWithUnit(owner.accessToken);
    const dev = await device(owner.accessToken, c.facilityId);
    const pin = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: c.id, method: 'pin' });
    expect((await verify(dev, pin.body.revealedSecret)).body.result).toBe('allowed');

    const cut = await http()
      .post(`/access/customers/${c.id}/suspend`)
      .set(auth(owner.accessToken))
      .send({ reason: 'Revisión' });
    expect(cut.body.changed).toBeGreaterThanOrEqual(1);

    const summary = await http().get(`/access/customers/${c.id}`).set(auth(owner.accessToken));
    expect(summary.status).toBe(200);
    expect(summary.body.lastAllowedAt).not.toBeNull();
    expect(summary.body.cutForDebt).toBe(false);
    expect(
      summary.body.credentials.every((x: { status: string }) => x.status === 'suspended'),
    ).toBe(true);

    await http().post(`/access/customers/${c.id}/resume`).set(auth(owner.accessToken)).expect(200);
    const resent = await http()
      .post(`/access/customers/${c.id}/resend`)
      .set(auth(owner.accessToken));
    expect(resent.status).toBe(200);
    expect(resent.body.sentTo).toBe(c.email);
  });

  it('avisa de quien entra cortado y respeta el interruptor', async () => {
    const owner = await registerVerifiedUser(app, 'accfalert');
    const c = await customerWithUnit(owner.accessToken);
    const dev = await device(owner.accessToken, c.facilityId);
    const pin = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: c.id, method: 'pin' });
    await admin.accessCredential.update({
      where: { id: pin.body.id },
      data: { status: 'suspended', suspendReason: 'dunning:invoice-x' },
    });
    const denied = await verify(dev, pin.body.revealedSecret);
    expect(denied.body.result).toBe('denied_dunning');
    await verify(dev, pin.body.revealedSecret);
    const row = await admin.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const alerts = await admin.notification.findMany({
      where: { tenantId: row.id, type: 'access.cut_attempt' },
    });
    expect(alerts).toHaveLength(1);

    const off = await http()
      .patch('/settings/tenant/access')
      .set(auth(owner.accessToken))
      .send({ accessAlerts: { cutAttempt: false }, accessCutMode: 'extras', accessCutDays: 20 });
    expect(off.status).toBe(200);
    expect(off.body.accessAlerts).toMatchObject({ cutAttempt: false, deviceOffline: true });
    expect(off.body.accessCutDays).toBe(20);
  });

  it('un equipo sin latido pasa a sin conexión y avisa una vez', async () => {
    const owner = await registerVerifiedUser(app, 'accfhealth');
    const c = await customerWithUnit(owner.accessToken);
    const dev = await device(owner.accessToken, c.facilityId);
    await http()
      .post('/access/heartbeat')
      .set('X-Device-Key', dev.revealedApiKey)
      .send({ deviceId: dev.hardwareId })
      .expect(204);
    const before = await admin.accessDevice.findUniqueOrThrow({ where: { id: dev.id } });
    expect(before.isOnline).toBe(true);

    await admin.accessDevice.update({
      where: { id: dev.id },
      data: {
        lastSeenAt: new Date(Date.now() - 3_600_000),
        lastHeartbeatAt: new Date(Date.now() - 3_600_000),
      },
    });
    const service = app.get(AccessDevicesService);
    await service.checkAll();
    await service.checkAll();
    const after = await admin.accessDevice.findUniqueOrThrow({ where: { id: dev.id } });
    expect(after.isOnline).toBe(false);
    const alerts = await admin.notification.findMany({
      where: { tenantId: after.tenantId, type: 'access.device_offline' },
    });
    expect(alerts).toHaveLength(1);
  });

  it('un terminal enseña lo que tiene y se le puede reenviar', async () => {
    const owner = await registerVerifiedUser(app, 'accfsync');
    const c = await customerWithUnit(owner.accessToken);
    await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: c.id, method: 'pin' })
      .expect(201);
    const dev = await device(owner.accessToken, c.facilityId);
    const again = await http()
      .post(`/access/devices/${dev.id}/resync`)
      .set(auth(owner.accessToken));
    expect(again.status).toBe(200);
    expect(again.body.sent).toBeGreaterThanOrEqual(1);
    const status = await http().get('/access/sync-status').set(auth(owner.accessToken));
    const row = status.body.find((d: { deviceId: string }) => d.deviceId === dev.id);
    expect(row.failed).toBe(0);
    expect(row.synced).toBe(row.expected);

    const test = await http()
      .post('/access/devices/test-connection')
      .set(auth(owner.accessToken))
      .send({ provider: 'http', controlUrl: 'http://127.0.0.1:9/abrir' });
    expect(test.status).toBe(200);
    expect(test.body.online).toBe(false);
  });

  it('un proveedor entra solo dentro de sus fechas y no sale con los inquilinos', async () => {
    const owner = await registerVerifiedUser(app, 'accftemp');
    const c = await customerWithUnit(owner.accessToken);
    const dev = await device(owner.accessToken, c.facilityId);
    const body = {
      holderName: 'Limpiezas Sol',
      holderKind: 'supplier',
      allowedFacilityIds: [c.facilityId],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const now = await http().post('/access/temporary').set(auth(owner.accessToken)).send(body);
    expect(now.status).toBe(201);
    expect(now.body.customerId).toBeNull();
    expect(now.body.customerName).toBe('Limpiezas Sol');
    expect((await verify(dev, now.body.revealedSecret)).body.result).toBe('allowed');

    const later = await http()
      .post('/access/temporary')
      .set(auth(owner.accessToken))
      .send({ ...body, validFrom: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await verify(dev, later.body.revealedSecret)).body.result).toBe('denied_outside_hours');

    const list = await http().get('/access/temporary').set(auth(owner.accessToken));
    expect(list.body).toHaveLength(2);
    const main = await http().get('/access/credentials').set(auth(owner.accessToken));
    expect(main.body.some((x: { customerId: string | null }) => !x.customerId)).toBe(false);
    const logs = await http().get('/access/logs').set(auth(owner.accessToken));
    expect(logs.body[0].customerName).toBe('Limpiezas Sol');
  });

  it('el corte por impago sigue la política del negocio', async () => {
    expect(
      dunningCalendar({ enabled: false, graceDays: 0 }, { mode: 'all', days: 20 }).find(
        (s) => s.type === 'access_block',
      )?.daysAfter,
    ).toBe(20);
    expect(
      dunningCalendar({ enabled: false, graceDays: 0 }, { mode: 'none', days: 20 }).some(
        (s) => s.type === 'access_block',
      ),
    ).toBe(false);
  });
});
