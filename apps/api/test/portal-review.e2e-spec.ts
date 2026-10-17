import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Revisión del portal del inquilino (2026-10-17). */
describe('Portal del inquilino: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  /** Sesión del portal con el enlace que genera el staff (sin pasar por el correo). */
  async function portalSession(staffToken: string, customerId: string): Promise<string> {
    const link = await http()
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return consume.body.accessToken as string;
  }

  async function signedContract(staffToken: string, customerId: string, unitId: string) {
    const auth = { Authorization: `Bearer ${staffToken}` };
    const c = await http().post('/contracts').set(auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return c.body.id as string;
  }

  it('lo pendiente de una factura con retención de IRPF descuenta la retención', async () => {
    const owner = await registerVerifiedUser(app, 'prv-irpf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signedContract(owner.accessToken, customerId, unitIds[0]!);
    await http()
      .put(`/contracts/${contractId}/irpf-retention`)
      .set(auth)
      .send({ pct: 19 })
      .expect(200);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);

    const pToken = await portalSession(owner.accessToken, customerId);
    const pAuth = { Authorization: `Bearer ${pToken}` };
    const invoices = await http().get('/portal/me/invoices').set(pAuth).expect(200);
    const inv = (invoices.body as { id: string; amountPending: number; amountPaid: number }[]).find(
      (i) => i.id === draft.body.id,
    );
    // 121 € de total − 19 € de retención = 102 € a pagar (antes salían 121 €).
    expect(inv).toMatchObject({ amountPending: 102, amountPaid: 0 });
    // La retención no figura como un cobro en el historial del inquilino.
    const payments = await http().get('/portal/me/payments').set(pAuth).expect(200);
    expect(payments.body).toEqual([]);
  });

  it('anular la baja desde el portal avisa al equipo', async () => {
    const owner = await registerVerifiedUser(app, 'prv-moveout');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signedContract(owner.accessToken, customerId, unitIds[0]!);
    const pAuth = { Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}` };

    const end = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await http()
      .post(`/portal/me/contracts/${contractId}/request-move-out`)
      .set(pAuth)
      .send({ endDate: end })
      .expect(200);
    const cancel = await http()
      .post(`/portal/me/contracts/${contractId}/cancel-move-out`)
      .set(pAuth)
      .expect(200);
    expect(cancel.body.status).toBe('active');

    // El aviso se crea en segundo plano.
    let types: string[] = [];
    for (let i = 0; i < 20 && !types.includes('contract.move_out_cancelled'); i++) {
      await new Promise((r) => setTimeout(r, 150));
      const list = await http().get('/notifications').set(auth).expect(200);
      const items = (Array.isArray(list.body) ? list.body : list.body.items) as { type: string }[];
      types = items.map((n) => n.type);
    }
    expect(types).toContain('contract.move_out_cancelled');
  });

  it('cambiar la contraseña exige la actual y la sesión cae si el negocio se suspende', async () => {
    const owner = await registerVerifiedUser(app, 'prv-session');
    const customerId = await createCustomer(app, owner.accessToken);
    const pAuth = { Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}` };

    // Primera contraseña: no hay actual que pedir.
    const first = await http()
      .post('/portal/me/password')
      .set(pAuth)
      .send({ password: 'Primera123' })
      .expect(200);
    const renewed = { Authorization: `Bearer ${first.body.accessToken as string}` };
    // Cambiarla sin la actual, o con una incorrecta → 400.
    const noCurrent = await http()
      .post('/portal/me/password')
      .set(renewed)
      .send({ password: 'Segunda123' });
    expect(noCurrent.status).toBe(400);
    expect(noCurrent.body.code).toBe('current_password_invalid');
    await http()
      .post('/portal/me/password')
      .set(renewed)
      .send({ password: 'Segunda123', currentPassword: 'mala-clave' })
      .expect(400);
    const ok = await http()
      .post('/portal/me/password')
      .set(renewed)
      .send({ password: 'Segunda123', currentPassword: 'Primera123' })
      .expect(200);
    const current = { Authorization: `Bearer ${ok.body.accessToken as string}` };

    // Negocio suspendido: cualquier llamada del portal deja de valer.
    await http().get('/portal/me/contracts').set(current).expect(200);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await admin.tenant.update({ where: { id: tenant.id }, data: { status: 'suspended' } });
    const blocked = await http().get('/portal/me/contracts').set(current);
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('account_unavailable');
  });

  it('la solicitud de trastero no admite un local de otro negocio', async () => {
    const owner = await registerVerifiedUser(app, 'prv-req');
    const other = await registerVerifiedUser(app, 'prv-req2');
    const { facilityId: foreignFacility } = await createFacilityWithUnits(app, other.accessToken, {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const pAuth = { Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}` };
    await http()
      .post('/portal/me/unit-requests')
      .set(pAuth)
      .send({ facilityId: foreignFacility, note: 'Quiero otro' })
      .expect(404);
  });
});
