import { getQueueToken } from '@nestjs/bullmq';
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

/** Segunda revisión del portal del inquilino (2026-10-28). */
describe('Portal del inquilino: segunda revisión (e2e)', () => {
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

  async function portalSession(staffToken: string, customerId: string): Promise<string> {
    const link = await http()
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return consume.body.accessToken as string;
  }

  async function signedContract(
    staffToken: string,
    customerId: string,
    unitId: string,
    extra: Record<string, unknown> = {},
  ) {
    const auth = { Authorization: `Bearer ${staffToken}` };
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 100,
        depositAmount: 0,
        ...extra,
      });
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return c.body.id as string;
  }

  it('sin un trastero en uso no se crean accesos adicionales ni pases (abrirían todo)', async () => {
    const owner = await registerVerifiedUser(app, 'prv2-scope');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .patch('/settings/tenant/access')
      .set(auth)
      .send({ nightPassEnabled: true, nightPassPrice: 0 })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Ex' });
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };

    const extra = await http().post('/portal/me/access/extra').set(portal).send({ label: 'Hijo' });
    expect(extra.status).toBe(409);
    expect(extra.body.code).toBe('no_active_contract');
    const info = await http().get('/portal/me/access/night-pass').set(portal).expect(200);
    expect(info.body.enabled).toBe(false);
    const pass = await http().post('/portal/me/access/night-pass').set(portal).send({});
    expect(pass.status).toBe(409);
    expect(await admin.accessCredential.count({ where: { customerId: customerId } })).toBe(0);

    // Con un contrato en marcha sí, y solo para su local.
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await signedContract(owner.accessToken, customerId, fac.unitIds[0]!);
    const ok = await http().post('/portal/me/access/extra').set(portal).send({ label: 'Hijo' });
    expect(ok.status).toBe(201);
    const cred = await admin.accessCredential.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(cred.allowedFacilityIds).toEqual([fac.facilityId]);

    // Un pase nocturno caducado sin usar ya no sale como acceso.
    const night = await http().post('/portal/me/access/night-pass').set(portal).send({});
    expect(night.status).toBe(201);
    await admin.accessCredential.update({
      where: { id: night.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const list = await http().get('/portal/me/access').set(portal).expect(200);
    const ids = (list.body as { id: string; extra?: boolean }[]).map((c) => c.id);
    expect(ids).not.toContain(night.body.id);
    expect(
      (list.body as { id: string; extra?: boolean }[]).find((c) => c.id === ok.body.id)?.extra,
    ).toBe(true);
  });

  it('cancelar la baja devuelve la fecha de fin original', async () => {
    const owner = await registerVerifiedUser(app, 'prv2-end');
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Fin' });
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const end = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const id = await signedContract(owner.accessToken, customerId, fac.unitIds[0]!, {
      endDate: end,
      autoRenew: false,
    });
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const moveOut = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await http()
      .post(`/portal/me/contracts/${id}/request-move-out`)
      .set(portal)
      .send({ endDate: moveOut })
      .expect(200);
    await http().post(`/portal/me/contracts/${id}/cancel-move-out`).set(portal).expect(200);
    const c = await admin.contract.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe('active');
    expect(c.endDate?.toISOString().slice(0, 10)).toBe(end);
    expect(c.endDateBeforeEnding).toBeNull();
  });

  it('el próximo cargo cuenta lo ya pagado por adelantado', async () => {
    const owner = await registerVerifiedUser(app, 'prv2-next');
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Next' });
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const id = await signedContract(owner.accessToken, customerId, fac.unitIds[0]!);
    // Facturación desde dentro de tres meses (cupón, primer pago con el mes siguiente…).
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 15));
    await admin.contract.update({ where: { id }, data: { billingStartsOn: start } });
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const account = await http().get('/portal/me/account').set(portal).expect(200);
    const expected = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    expect(account.body.nextCharge.date).toBe(expected.toISOString().slice(0, 10));
    // Desde el 15: la parte proporcional (100 € + 21 % = 121 €/mes).
    const days = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
    ).getUTCDate();
    expect(account.body.nextCharge.amount).toBeCloseTo((121 * (days - 14)) / days, 1);
  });

  it('«Mis datos» rechaza un DNI mal escrito y cerrar sesión la cierra en el servidor', async () => {
    const owner = await registerVerifiedUser(app, 'prv2-nif');
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Nif' });
    const token = await portalSession(owner.accessToken, customerId);
    const portal = { Authorization: `Bearer ${token}` };
    const bad = await http()
      .patch('/portal/me/profile')
      .set(portal)
      .send({ documentType: 'DNI', documentNumber: '12345678A' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_tax_id');
    const good = await http()
      .patch('/portal/me/profile')
      .set(portal)
      .send({ documentType: 'DNI', documentNumber: '12345678z' })
      .expect(200);
    expect(good.body.documentNumber).toBe('12345678Z');
    // Un pasaporte no se valida como DNI.
    await http()
      .patch('/portal/me/profile')
      .set(portal)
      .send({ documentType: 'Pasaporte', documentNumber: 'XDA123456' })
      .expect(200);

    await http().post('/portal/me/logout').set(portal).expect(204);
    await http().get('/portal/me/profile').set(portal).expect(401);

    // Cerrar todas: también las demás sesiones.
    const a = { Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}` };
    const b = { Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}` };
    await http().post('/portal/me/sessions/close-all').set(a).expect(204);
    await http().get('/portal/me/profile').set(b).expect(401);
    await http().get('/portal/me/profile').set(a).expect(401);
  });

  it('con el email repetido, el enlace de acceso es para el inquilino con contrato', async () => {
    const owner = await registerVerifiedUser(app, 'prv2-dup');
    await ensureDefaultSeries(app, owner.accessToken);
    const email = `dup-${Date.now()}@e2e.local`;
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const withContract = await createCustomer(app, owner.accessToken, {
      firstName: 'Bueno',
      email,
    });
    await signedContract(owner.accessToken, withContract, fac.unitIds[0]!);
    // Otra ficha posterior con el mismo email, sin contratos.
    const later = await createCustomer(app, owner.accessToken, { firstName: 'Nuevo', email });
    expect(later).not.toBe(withContract);
    await http()
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email: email.toUpperCase() })
      .expect(204);
    // El enlace se guarda en Redis con el inquilino al que da acceso.
    const queue = app.get<{ client: Promise<unknown> }>(getQueueToken('email'), { strict: false });
    const redis = (await queue.client) as {
      keys: (p: string) => Promise<string[]>;
      get: (k: string) => Promise<string | null>;
    };
    let found: string | null = null;
    for (let i = 0; i < 20 && !found; i++) {
      for (const k of await redis.keys('portal:magiclink:*')) {
        const v = JSON.parse((await redis.get(k)) ?? '{}') as { customerId?: string };
        if (v.customerId === withContract || v.customerId === later) found = v.customerId!;
      }
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    expect(found).toBe(withContract);
  });
});
