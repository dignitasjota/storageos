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
 * Segunda revisión de Analítica: el dinero solo con permiso, aplicar el precio de
 * un tipo cambia también sus trasteros libres, las bajas de quien entra y sale el
 * mismo mes, el riesgo de baja por inquilino, los locales por abrir fuera de las
 * cifras de la empresa, las facturas de cada emisor y un local mal escrito.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Revisión de Analítica, 2 (e2e)', () => {
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

  async function signed(token: string, unitId: string, customerId?: string, price = 50) {
    const customer = customerId ?? (await createCustomer(app, token));
    const c = await http()
      .post('/contracts')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: customer, unitId, startDate: '2025-01-01', priceMonthly: price });
    expect(c.status).toBe(201);
    await http()
      .post(`/contracts/${c.body.id}/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    return { id: c.body.id as string, customerId: customer };
  }

  it('sin permiso para ver facturas y cobros no hay dinero; un local mal escrito da 400', async () => {
    const owner = await registerVerifiedUser(app, 'an2money');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await signed(owner.accessToken, unitIds[0]!);

    // Un rol que ve la analítica pero no el dinero.
    const email = `an2-seller-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(ownerAuth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email);
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Comercial', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    const role = await http()
      .post('/settings/roles')
      .set(ownerAuth)
      .send({ name: 'Solo analítica', permissions: ['analytics:read'], baseRole: 'staff' })
      .expect(201);
    await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(ownerAuth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    await http().get('/analytics/monthly-revenue').set(auth).expect(403);
    await http().get('/analytics/aging').set(auth).expect(403);
    await http().get('/analytics/revenue-breakdown').set(auth).expect(403);
    const occ = await http().get('/analytics/occupancy').set(auth).expect(200);
    expect(occ.body).toMatchObject({ occupiedUnits: 1, mrrActual: null, mrrPotential: null });
    const forecast = await http().get('/analytics/forecast').set(auth).expect(200);
    expect(forecast.body.current.mrr).toBeNull();
    const overview = await http().get('/dashboard/overview').set(auth).expect(200);
    expect(overview.body.revenue).toBeNull();
    expect(overview.body.receivables).toBeNull();

    // El dueño sí lo ve.
    const ownerOcc = await http().get('/analytics/occupancy').set(ownerAuth).expect(200);
    expect(ownerOcc.body.mrrActual).toBe(50);

    const bad = await http().get('/analytics/occupancy?facilityId=abc').set(ownerAuth);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_facility_id');
  });

  it('aplicar el precio de un tipo cambia también sus trasteros libres', async () => {
    const owner = await registerVerifiedUser(app, 'an2apply');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 50,
    });
    await signed(owner.accessToken, unitIds[0]!);

    const suggestions = await http().get('/analytics/pricing-suggestions').set(auth).expect(200);
    const item = (
      suggestions.body.items as { unitTypeId: string; availableUnitsAll: number }[]
    ).find((i) => i.unitTypeId === unitTypeId)!;
    expect(item.availableUnitsAll).toBe(2);

    const applied = await http()
      .post('/analytics/pricing-suggestions/apply')
      .set(auth)
      .send({ unitTypeId, price: 55 })
      .expect(201);
    expect(applied.body).toMatchObject({ previousPrice: 50, newPrice: 55, unitsUpdated: 2 });

    const units = await db.unit.findMany({
      where: { id: { in: unitIds } },
      select: { id: true, basePriceMonthly: true },
    });
    const price = new Map(units.map((u) => [u.id, Number(u.basePriceMonthly)]));
    // El alquilado conserva su precio; los libres se venden al nuevo.
    expect(price.get(unitIds[0]!)).toBe(50);
    expect(price.get(unitIds[1]!)).toBe(55);
    expect(price.get(unitIds[2]!)).toBe(55);
    const history = await db.unitPriceHistory.count({ where: { unitId: { in: unitIds } } });
    expect(history).toBe(2);

    // Un precio de 0 no vale para un trastero.
    await http()
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId: unitIds[1], price: 0 })
      .expect(400);
  });

  it('bajas del mismo mes, riesgo por inquilino y locales por abrir fuera de las cifras', async () => {
    const owner = await registerVerifiedUser(app, 'an2churn');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const open = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const soon = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    await db.facility.update({ where: { id: soon.facilityId }, data: { preOpening: true } });

    // Un inquilino con dos trasteros y una factura vencida.
    const a = await signed(owner.accessToken, open.unitIds[0]!);
    await signed(owner.accessToken, open.unitIds[1]!, a.customerId);
    // Firmados hace tiempo: no son altas de este mes.
    await db.contract.updateMany({
      where: { customerId: a.customerId },
      data: { signedAt: new Date('2025-01-01T10:00:00Z') },
    });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    await db.invoice.create({
      data: {
        tenantId: tenant.id,
        seriesId,
        sequenceNumber: 900,
        customerId: a.customerId,
        contractId: a.id,
        invoiceNumber: `AN2-${Date.now()}`,
        status: 'overdue',
        issueDate: new Date('2025-02-01'),
        dueDate: new Date('2025-02-15'),
        subtotal: 50,
        taxAmount: 10.5,
        total: 60.5,
      },
    });

    // Entra y se va este mes: cuenta como baja.
    const b = await signed(owner.accessToken, open.unitIds[2]!);
    const now = new Date();
    await db.contract.update({
      where: { id: b.id },
      data: {
        startDate: now,
        signedAt: now,
        status: 'ended',
        endedAt: new Date(now.getTime() + 1000),
      },
    });

    const churn = await http().get('/analytics/churn').set(auth).expect(200);
    const month = churn.body.months[churn.body.months.length - 1];
    expect(month).toMatchObject({ started: 1, ended: 1 });

    const risk = await http().get('/analytics/churn-risk').set(auth).expect(200);
    const rows = (risk.body.items as { customerId: string; contractCount: number }[]).filter(
      (i) => i.customerId === a.customerId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contractCount).toBe(2);

    // Los 2 trasteros del local por abrir no cuentan en la empresa…
    const company = await http().get('/analytics/occupancy').set(auth).expect(200);
    expect(company.body.totalUnits).toBe(3);
    // …pero sí al mirar ese local.
    const local = await http()
      .get(`/analytics/occupancy?facilityId=${soon.facilityId}`)
      .set(auth)
      .expect(200);
    expect(local.body.totalUnits).toBe(2);

    // «Hace un año» llega aparte (aún no había trasteros).
    const history = await http().get('/analytics/occupancy-history?months=6').set(auth).expect(200);
    expect(history.body.points).toHaveLength(6);
    expect(history.body).toHaveProperty('yearAgo');
  });

  it('las facturas de un propietario van aparte de las del negocio', async () => {
    const owner = await registerVerifiedUser(app, 'an2owner');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const c = await signed(owner.accessToken, unitIds[0]!);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    const prop = await db.owner.create({
      data: {
        tenantId: tenant.id,
        legalName: 'Propietario Uno SL',
        taxId: 'B12345674',
      },
    });
    const today = new Date();
    const issueDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    for (const [ownerId, total] of [
      [null, 121],
      [prop.id, 242],
    ] as const) {
      await db.invoice.create({
        data: {
          tenantId: tenant.id,
          seriesId,
          sequenceNumber: total,
          customerId: c.customerId,
          contractId: c.id,
          ownerId,
          invoiceNumber: `AN2O-${total}-${Date.now()}`,
          status: 'issued',
          issueDate,
          subtotal: total / 1.21,
          taxAmount: total - total / 1.21,
          total,
        },
      });
    }
    const sum = (body: { points: { invoiced: number }[] }) =>
      body.points.reduce((s, p) => s + p.invoiced, 0);

    const own = await http().get('/analytics/monthly-revenue?months=1').set(auth).expect(200);
    expect(sum(own.body)).toBe(121);
    const theirs = await http()
      .get(`/analytics/monthly-revenue?months=1&ownerId=${prop.id}`)
      .set(auth)
      .expect(200);
    expect(sum(theirs.body)).toBe(242);
    const all = await http().get('/analytics/monthly-revenue?months=1&ownerId=all').set(auth);
    expect(sum(all.body)).toBe(363);
  });
});
