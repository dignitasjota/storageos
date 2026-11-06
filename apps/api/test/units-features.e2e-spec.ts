import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Trasteros: lista con inquilino, cuota, deuda y días libre, vistas
 * del equipo, características y fotos, motivo de los parados y lote de precios
 * con redondeo.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

interface Row {
  id: string;
  daysVacant: number | null;
  tenant: { customerName: string; monthly: number; overdue: number | null } | null;
  offer: { code: string } | null;
  outOfService: { days: number; lostIncome: number } | null;
}

describe('Mejoras de Trasteros (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  async function setup(slug: string, unitsCount = 3) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, { unitsCount });
    return { owner, auth, ...f };
  }

  it('la lista trae inquilino, cuota, deuda, días libre, oferta y parados', async () => {
    const s = await setup('uft-overview');
    await ensureDefaultSeries(app, s.owner.accessToken);
    const [rented, free, stopped] = s.unitIds as [string, string, string];
    const customerId = await createCustomer(app, s.owner.accessToken, {
      firstName: 'Marta',
      lastName: 'Ruiz',
    });
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({
        customerId,
        unitId: rented,
        startDate: isoDay(-30),
        priceMonthly: 45,
        discountAmount: 5,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({}).expect(200);
    const invoice = await http()
      .post('/invoices')
      .set(s.auth)
      .send({
        customerId,
        contractId: c.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${invoice.body.id}/issue`).set(s.auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: invoice.body.id },
      data: { dueDate: new Date(isoDay(-5)) },
    });

    await http()
      .post('/promotions/unit-offers')
      .set(s.auth)
      .send({ unitId: free, freeMonths: 1, validDays: 30 })
      .expect(201);
    await http()
      .post(`/units/${stopped}/change-status`)
      .set(s.auth)
      .send({ status: 'blocked', reason: 'Gotera en el techo' })
      .expect(200);
    await db.unit.update({
      where: { id: stopped },
      data: { outOfServiceSince: new Date(Date.now() - 15 * DAY) },
    });

    const res = await http()
      .get(`/units/overview?facilityId=${s.facilityId}`)
      .set(s.auth)
      .expect(200);
    expect(res.body).toMatchObject({ tenantsVisible: true, moneyVisible: true });
    const byId = new Map((res.body.rows as Row[]).map((r) => [r.id, r]));
    expect(byId.get(rented)?.tenant).toMatchObject({
      customerName: 'Marta Ruiz',
      monthly: 40,
      overdue: 121,
    });
    expect(byId.get(free)).toMatchObject({ tenant: null, daysVacant: 0 });
    expect(byId.get(free)?.offer?.code).toMatch(/^OF-/);
    // 15 días de un trastero a 50 €: medio mes.
    expect(byId.get(stopped)?.outOfService).toEqual({ days: 15, lostIncome: 25 });

    const detail = await http().get(`/units/${stopped}`).set(s.auth).expect(200);
    expect(detail.body.outOfServiceReason).toBe('Gotera en el techo');
    const insights = await http().get(`/units/${rented}/insights`).set(s.auth).expect(200);
    expect(insights.body.currentFee).toBe(40);

    await http().get('/units/overview?facilityId=x').set(s.auth).expect(400);
  });

  it('el motivo sigue mientras está parado y desaparece al volver', async () => {
    const s = await setup('uft-reason', 1);
    const unitId = s.unitIds[0]!;
    const change = (body: object) =>
      http().post(`/units/${unitId}/change-status`).set(s.auth).send(body).expect(200);
    const first = await change({ status: 'maintenance', reason: 'Pintar' });
    expect(first.body.outOfServiceReason).toBe('Pintar');
    const since = first.body.outOfServiceSince as string;

    const blocked = await change({ status: 'blocked' });
    expect(blocked.body).toMatchObject({ outOfServiceReason: 'Pintar', outOfServiceSince: since });

    const back = await change({ status: 'available' });
    expect(back.body).toMatchObject({ outOfServiceReason: null, outOfServiceSince: null });
  });

  it('vistas del equipo', async () => {
    const s = await setup('uft-views', 1);
    const view = await http()
      .post('/units/views')
      .set(s.auth)
      .send({ name: 'Grandes libres', filters: { minArea: '6', status: 'available' } })
      .expect(201);
    await http()
      .post('/units/views')
      .set(s.auth)
      .send({ name: 'Grandes libres', filters: { minArea: '8' } })
      .expect(201);
    const list = await http().get('/units/views').set(s.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].filters).toEqual({ minArea: '8' });

    await http().delete(`/units/views/${view.body.id}`).set(s.auth).expect(204);
    expect((await http().get('/units/views').set(s.auth).expect(200)).body).toEqual([]);
  });

  it('características y fotos del trastero', async () => {
    const s = await setup('uft-images', 1);
    const unitId = s.unitIds[0]!;
    const features = await http()
      .patch(`/units/${unitId}`)
      .set(s.auth)
      .send({ features: ['ground_floor', 'climate'] })
      .expect(200);
    expect(features.body.features).toEqual(['ground_floor', 'climate']);
    await http()
      .patch(`/units/${unitId}`)
      .set(s.auth)
      .send({ features: ['nope'] })
      .expect(400);

    const up = await http()
      .post(`/units/${unitId}/images/upload-url`)
      .set(s.auth)
      .send({ mimeType: 'image/png', sizeBytes: 70 })
      .expect(200);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const put = await fetch(up.body.uploadUrl as string, {
      method: 'PUT',
      headers: up.body.requiredHeaders as Record<string, string>,
      body: png,
    });
    expect(put.ok).toBe(true);

    const saved = await http()
      .put(`/units/${unitId}/images`)
      .set(s.auth)
      .send({ images: [up.body.key] })
      .expect(200);
    expect(saved.body.images[0].key).toBe(up.body.key);
    expect(saved.body.images[0].url).toContain(up.body.key);

    const foreign = await http()
      .put(`/units/${unitId}/images`)
      .set(s.auth)
      .send({ images: ['otro-tenant/units/x/images/a.png'] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('invalid_image_key');

    await http().put(`/units/${unitId}/images`).set(s.auth).send({ images: [] }).expect(200);
  });

  it('lote de precios con redondeo y ficha de un apilado', async () => {
    const s = await setup('uft-round', 2);
    const bulk = await http()
      .post('/units/bulk')
      .set(s.auth)
      .send({ action: 'price', unitIds: s.unitIds, mode: 'percent', value: 7, round: 'five' })
      .expect(200);
    expect(bulk.body).toMatchObject({ updated: 2, failed: [] });
    const unit = await http().get(`/units/${s.unitIds[0]}`).set(s.auth).expect(200);
    // 50 € + 7 % = 53,50 €, a 5 €: 55 €.
    expect(unit.body.basePriceMonthly).toBe(55);

    const type = await http()
      .post('/unit-types')
      .set(s.auth)
      .send({ name: 'Taquilla', defaultPriceMonthly: 20, stackable: true })
      .expect(201);
    const make = async (code: string) =>
      (
        await http()
          .post('/units')
          .set(s.auth)
          .send({
            facilityId: s.facilityId,
            unitTypeId: type.body.id,
            code,
            widthM: 1,
            depthM: 1,
            heightM: 1,
            features: ['lighting'],
          })
          .expect(201)
      ).body as { id: string; features: string[] };
    const upper = await make('T1');
    const lower = await make('T2');
    expect(upper.features).toEqual(['lighting']);
    await http()
      .post(`/units/${upper.id}/stack-with`)
      .set(s.auth)
      .send({ targetUnitId: lower.id })
      .expect(200);
    const insights = await http().get(`/units/${upper.id}/insights`).set(s.auth).expect(200);
    expect(insights.body.stackPartner).toMatchObject({ id: lower.id, code: 'T2' });
  });

  it('quien no puede ver inquilinos ni dinero no los recibe', async () => {
    const s = await setup('uft-rbac', 1);
    const customerId = await createCustomer(app, s.owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: s.unitIds[0], startDate: isoDay(-1), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(s.auth).send({}).expect(200);

    const role = await http()
      .post('/settings/roles')
      .set(s.auth)
      .send({ name: 'Solo trasteros', permissions: ['units:read'], baseRole: 'readonly' })
      .expect(201);
    // El propietario siempre lo ve todo: hace falta otra persona del equipo.
    const email = `staff-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(s.auth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Solo Trasteros', password: 'Passw0rd!' })
      .expect(200);
    const staff = await db.user.findFirstOrThrow({ where: { email } });
    await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(s.auth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: s.owner.slug, email, password: 'Passw0rd!' })
      .expect(200);

    const res = await http()
      .get('/units/overview')
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .expect(200);
    expect(res.body).toMatchObject({ tenantsVisible: false, moneyVisible: false });
    expect((res.body.rows as Row[])[0]?.tenant).toBeNull();
  });
});
