import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

describe('Revisión de accesos', () => {
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

  async function newCustomer(token: string): Promise<{ id: string; email: string }> {
    const email = `acc-${Math.random().toString(36).slice(2, 10)}@e2e.local`;
    return { id: await createCustomer(app, token, { email }), email };
  }

  async function device(
    token: string,
    facilityId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; revealedApiKey: string; hardwareId: string }> {
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
    return res.body;
  }

  async function verify(
    dev: { revealedApiKey: string; hardwareId: string },
    method: string,
    credential: string,
  ): Promise<string> {
    const res = await http()
      .post('/access/verify')
      .set('X-Device-Key', dev.revealedApiKey)
      .send({ deviceId: dev.hardwareId, method, credential });
    return res.body.result;
  }

  it('una credencial nueva se limita a lo del inquilino; abrirlo todo hay que pedirlo', async () => {
    const owner = await registerVerifiedUser(app, 'accrevscope');
    const customer = await newCustomer(owner.accessToken);
    const none = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'pin' });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('credential_scope_required');

    const { facilityId, unitId } = await signedContractFor(app, owner.accessToken, customer);
    const own = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'pin', label: 'Manual' });
    expect(own.status).toBe(201);
    expect(own.body.allowedFacilityIds).toEqual([facilityId]);
    expect(own.body.allowedUnitIds).toEqual([unitId]);
    // Del PIN solo se enseñan las dos últimas cifras.
    expect(own.body.secretPreview).toBe(`••••${own.body.revealedSecret.slice(-2)}`);
  });

  it('un PIN reutilizado tras revocar abre, y una tarjeta no se repite', async () => {
    const owner = await registerVerifiedUser(app, 'accrevpin');
    const a = await newCustomer(owner.accessToken);
    const b = await newCustomer(owner.accessToken);
    const { facilityId } = await signedContractFor(app, owner.accessToken, a);
    const dev = await device(owner.accessToken, facilityId);
    const body = { customerId: a.id, method: 'pin', pin: '482915', allFacilities: true };
    const first = await http().post('/access/credentials').set(auth(owner.accessToken)).send(body);
    expect(first.status).toBe(201);
    await http()
      .post(`/access/credentials/${first.body.id}/revoke`)
      .set(auth(owner.accessToken))
      .expect(200);
    const second = await http().post('/access/credentials').set(auth(owner.accessToken)).send(body);
    expect(second.status).toBe(201);
    expect(await verify(dev, 'pin', '482915')).toBe('allowed');

    const card = { method: 'rfid', rfidUid: 'CAFE0001', allFacilities: true };
    await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ ...card, customerId: a.id })
      .expect(201);
    const dup = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ ...card, rfidUid: 'cafe0001', customerId: b.id });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('rfid_in_use');
  });

  it('comprobar la conexión no abre, exige gestión y anota el latido', async () => {
    const owner = await registerVerifiedUser(app, 'accrevping');
    const customer = await newCustomer(owner.accessToken);
    const { facilityId } = await signedContractFor(app, owner.accessToken, customer);
    const dev = await device(owner.accessToken, facilityId);
    const ping = await http().post(`/access/devices/${dev.id}/ping`).set(auth(owner.accessToken));
    expect(ping.body).toEqual({ supported: true, online: true });
    const logs = await http().get('/access/logs').set(auth(owner.accessToken));
    expect(logs.body).toHaveLength(0);

    await admin.accessDevice.update({
      where: { id: dev.id },
      data: { isOnline: false, lastSeenAt: null },
    });
    await verify(dev, 'pin', '000000');
    const row = await admin.accessDevice.findUniqueOrThrow({ where: { id: dev.id } });
    expect(row.isOnline).toBe(true);
    expect(row.lastSeenAt).not.toBeNull();

    const key = await http()
      .post(`/access/devices/${dev.id}/regenerate-api-key`)
      .set(auth(owner.accessToken));
    expect(key.status).toBe(200);
  });

  it('al irse del todo se revoca todo; pagar una deuda vieja no devuelve el acceso', async () => {
    const owner = await registerVerifiedUser(app, 'accrevgone');
    const customer = await newCustomer(owner.accessToken);
    const { contractId, facilityId } = await signedContractFor(app, owner.accessToken, customer);
    const dev = await device(owner.accessToken, facilityId);
    const card = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'rfid', rfidUid: 'BEEF0002' });
    expect(card.status).toBe(201);
    const pin = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'pin' });
    await admin.accessCredential.update({
      where: { id: pin.body.id },
      data: { status: 'suspended', suspendReason: 'dunning:invoice-x' },
    });

    await http()
      .post(`/contracts/${contractId}/end`)
      .set(auth(owner.accessToken))
      .send({ endDate: new Date().toISOString().slice(0, 10) })
      .expect((res) => expect([200, 201]).toContain(res.status));

    // El listener corre en segundo plano.
    let rows = await admin.accessCredential.findMany({ where: { customerId: customer.id } });
    for (let i = 0; i < 30 && !rows.every((r) => r.status === 'revoked'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await admin.accessCredential.findMany({ where: { customerId: customer.id } });
    }
    expect(rows.every((r) => r.status === 'revoked')).toBe(true);
    expect(await verify(dev, 'rfid', 'BEEF0002')).toBe('denied_inactive_credential');
  });

  it('lo caducado se marca solo y sale como caducado', async () => {
    const owner = await registerVerifiedUser(app, 'accrevexp');
    const customer = await newCustomer(owner.accessToken);
    await signedContractFor(app, owner.accessToken, customer);
    const res = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'pin' });
    await admin.accessCredential.update({
      where: { id: res.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const list = await http()
      .get(`/access/credentials/page?customerId=${customer.id}`)
      .set(auth(owner.accessToken));
    const item = list.body.items.find((c: { id: string }) => c.id === res.body.id);
    expect(item.status).toBe('expired');

    await app.get(AccessCredentialsService).sweep();
    const row = await admin.accessCredential.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe('expired');
  });

  it('con el acceso cortado no se da otro desde el área de clientes y la cerradura ajena no sale', async () => {
    const owner = await registerVerifiedUser(app, 'accrevcut');
    const customer = await newCustomer(owner.accessToken);
    const other = await newCustomer(owner.accessToken);
    const { facilityId } = await signedContractFor(app, owner.accessToken, customer);
    const foreign = await signedContractFor(app, owner.accessToken, other, facilityId);
    await device(owner.accessToken, facilityId, {
      type: 'unit_lock',
      name: 'Cerradura ajena',
      unitId: foreign.unitId,
    });
    await device(owner.accessToken, facilityId, { name: 'Entrada' });
    await admin.tenant.updateMany({
      where: { slug: owner.slug },
      data: { extraAccessLimit: 2, nightPassEnabled: true },
    });

    await http()
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email: customer.email })
      .expect(204);
    const mail = await waitForEmail(customer.email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const session = await http().post('/portal/login/consume').send({ token });
    const portal = auth(session.body.accessToken);

    const doors = await http().get('/portal/me/doors').set(portal);
    expect(doors.body.map((d: { name: string }) => d.name)).toEqual(['Entrada']);

    const pin = await http()
      .post('/access/credentials')
      .set(auth(owner.accessToken))
      .send({ customerId: customer.id, method: 'pin' });
    await admin.accessCredential.update({
      where: { id: pin.body.id },
      data: { status: 'suspended', suspendReason: 'dunning:invoice-x' },
    });
    for (const [path, body] of [
      ['/portal/me/access/extra', { label: 'Familiar' }],
      ['/portal/me/access/visitor', { name: 'Mudanza' }],
      ['/portal/me/access/night-pass', {}],
    ] as const) {
      const res = await http().post(path).set(portal).send(body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('access_cut_for_debt');
    }
  });
});
