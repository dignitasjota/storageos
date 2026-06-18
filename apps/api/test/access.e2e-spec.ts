import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Fase 7: access credentials + devices + verify (e2e)', () => {
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

  it('credential PIN: crea → reveal + secretPreview, list NO incluye revealedSecret', async () => {
    const owner = await registerVerifiedUser(app, 'access-pin');
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Lopez', country: 'ES' });
    expect(customer.status).toBe(201);

    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: customer.body.id, method: 'pin' });
    expect(cred.status).toBe(201);
    expect(cred.body.method).toBe('pin');
    expect(cred.body.revealedSecret).toMatch(/^\d{6}$/);
    expect(cred.body.secretPreview).toMatch(/^\d{4}$/);

    const list = await request(app.getHttpServer())
      .get('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body[0]).not.toHaveProperty('revealedSecret');
    expect(list.body[0].secretPreview).toBe(cred.body.secretPreview);
  });

  it('credential RFID: requiere rfidUid', async () => {
    const owner = await registerVerifiedUser(app, 'access-rfid');
    const cust = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Bea', lastName: 'Diaz', country: 'ES' });
    const bad = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: cust.body.id, method: 'rfid' });
    expect(bad.status).toBe(400);

    const ok = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: cust.body.id, method: 'rfid', rfidUid: 'AB12CD34' });
    expect(ok.status).toBe(201);
    expect(ok.body.rfidUid).toBe('AB12CD34');
    expect(ok.body.revealedSecret).toBeNull();
  });

  it('suspend → resume → revoke state machine', async () => {
    const owner = await registerVerifiedUser(app, 'access-sm');
    const cust = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Carlos', lastName: 'Vega', country: 'ES' });
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: cust.body.id, method: 'pin' });
    expect(cred.body.status).toBe('active');

    const sus = await request(app.getHttpServer())
      .post(`/access/credentials/${cred.body.id}/suspend`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'test' });
    expect([200, 201]).toContain(sus.status);
    expect(sus.body.status).toBe('suspended');

    const res = await request(app.getHttpServer())
      .post(`/access/credentials/${cred.body.id}/resume`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send();
    expect(res.body.status).toBe('active');

    const rev = await request(app.getHttpServer())
      .post(`/access/credentials/${cred.body.id}/revoke`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send();
    expect(rev.body.status).toBe('revoked');
    expect(rev.body.revokedAt).toBeTruthy();
  });

  it('devices: crea → reveal API key → ping', async () => {
    const owner = await registerVerifiedUser(app, 'access-dev');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Norte' });
    expect(facility.status).toBe(201);

    const dev = await request(app.getHttpServer())
      .post('/access/devices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        type: 'door',
        name: 'Puerta principal',
        hardwareId: 'door-001',
      });
    expect(dev.status).toBe(201);
    expect(dev.body.revealedApiKey).toBeTruthy();
    expect(dev.body.apiKeyPreview).toBeTruthy();

    const ping = await request(app.getHttpServer())
      .post(`/access/devices/${dev.body.id}/ping`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send();
    expect([200, 201]).toContain(ping.status);
  });

  it('devices: controlUrl/secret + apertura remota (stub → dispatched)', async () => {
    const owner = await registerVerifiedUser(app, 'access-open');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local HTTP' });
    expect(facility.status).toBe(201);

    const dev = await request(app.getHttpServer())
      .post('/access/devices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        type: 'door',
        name: 'Puerta HTTP',
        hardwareId: 'http-door-001',
        controlUrl: 'https://controller.example/open',
        controlSecret: 'secreto-hmac-largo',
      });
    expect(dev.status).toBe(201);
    // El secreto NO se expone; sí un flag de que existe + la URL.
    expect(dev.body.controlUrl).toBe('https://controller.example/open');
    expect(dev.body.hasControlSecret).toBe(true);
    expect(dev.body.controlSecret).toBeUndefined();

    // Apertura remota: en test LOCK_PROVIDER=stub → dispatched true.
    const open = await request(app.getHttpServer())
      .post(`/access/devices/${dev.body.id}/open`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send();
    expect([200, 201]).toContain(open.status);
    expect(open.body.dispatched).toBe(true);

    // Queda registrado en el audit trail de accesos (remote).
    const logs = await request(app.getHttpServer())
      .get('/access/logs')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(logs.status).toBe(200);
    const items = (logs.body.items ?? logs.body) as { reason: string | null }[];
    expect(items.some((l) => l.reason === 'remote_open_by_staff')).toBe(true);
  });

  it('verify: PIN correcto → allowed; PIN incorrecto → denied + audit log', async () => {
    const owner = await registerVerifiedUser(app, 'access-verify');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Verify' });
    const cust = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Lopez', country: 'ES' });
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: cust.body.id, method: 'pin' });
    const dev = await request(app.getHttpServer())
      .post('/access/devices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        type: 'door',
        name: 'Puerta',
        hardwareId: 'verify-dev-001',
      });
    const apiKey = dev.body.revealedApiKey as string;

    // PIN correcto
    const ok = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: cred.body.revealedSecret, deviceId: dev.body.hardwareId });
    expect(ok.status).toBe(200);
    expect(ok.body.allowed).toBe(true);
    expect(ok.body.result).toBe('allowed');

    // PIN incorrecto
    const bad = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: '000000', deviceId: dev.body.hardwareId });
    expect(bad.status).toBe(200);
    expect(bad.body.allowed).toBe(false);
    expect(bad.body.result).toBe('denied_invalid_credential');

    // API key inválida → 401
    const noauth = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', 'wrong-key')
      .send({ method: 'pin', credential: cred.body.revealedSecret, deviceId: dev.body.hardwareId });
    expect(noauth.status).toBe(401);

    // Audit logs persisten
    const logs = await request(app.getHttpServer())
      .get('/access/logs')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(logs.status).toBe(200);
    expect(logs.body.length).toBeGreaterThanOrEqual(2);
    expect(logs.body.some((l: { result: string }) => l.result === 'allowed')).toBe(true);
    expect(
      logs.body.some((l: { result: string }) => l.result === 'denied_invalid_credential'),
    ).toBe(true);
  });

  it('credencial suspendida bloquea verify', async () => {
    const owner = await registerVerifiedUser(app, 'access-sus');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local SUS' });
    const cust = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Xavier', lastName: 'Mora', country: 'ES' });
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerId: cust.body.id, method: 'pin' });
    const dev = await request(app.getHttpServer())
      .post('/access/devices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        type: 'door',
        name: 'P',
        hardwareId: 'sus-dev-001',
      });

    await request(app.getHttpServer())
      .post(`/access/credentials/${cred.body.id}/suspend`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'manual test' });

    const v = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', dev.body.revealedApiKey)
      .send({ method: 'pin', credential: cred.body.revealedSecret, deviceId: dev.body.hardwareId });
    expect(v.body.allowed).toBe(false);
    expect(['denied_inactive_credential', 'denied_invalid_credential']).toContain(v.body.result);
  });
});
