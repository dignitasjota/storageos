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
 * Revisión de Inventario: ventas de mostrador cobradas (y sin doble cargo),
 * productos y stock, descuadres corregibles, locales borrados, trasteros con
 * historial, códigos sin distinguir mayúsculas, tipos y locales inactivos en la
 * reserva, horarios y alcance por local en plantas y stock.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Revisión de Inventario (e2e)', () => {
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

  async function product(token: string, facilityId: string, sku: string, price = 10) {
    const auth = { Authorization: `Bearer ${token}` };
    const p = await http()
      .post('/products')
      .set(auth)
      .send({ sku, name: `Producto ${sku}`, price });
    expect(p.status).toBe(201);
    await http()
      .put(`/products/${p.body.id}/stock`)
      .set(auth)
      .send({ facilityId, quantity: 10 })
      .expect(200);
    return p.body.id as string;
  }

  it('ventas de mostrador: cobradas en la factura, pendientes, sin inquilino y devueltas', async () => {
    const owner = await registerVerifiedUser(app, 'invsale');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await ensureDefaultSeries(app, owner.accessToken);
    const productId = await product(owner.accessToken, facilityId, 'CANDADO');
    const customerId = await createCustomer(app, owner.accessToken);

    // Efectivo: factura pagada con su cobro.
    const cash = await http()
      .post('/product-sales')
      .set(auth)
      .send({ facilityId, customerId, items: [{ productId, quantity: 2 }], paymentMethod: 'cash' })
      .expect(201);
    expect(cash.body.status).toBe('paid');
    const cashInvoice = await db.invoice.findUniqueOrThrow({
      where: { id: cash.body.invoiceId },
      include: { payments: true },
    });
    expect(cashInvoice.status).toBe('paid');
    expect(cashInvoice.payments).toHaveLength(1);
    expect(cashInvoice.payments[0]!.methodType).toBe('cash');

    // Pendiente: la factura queda por cobrar; al cobrarla, la venta pasa a pagada.
    const later = await http()
      .post('/product-sales')
      .set(auth)
      .send({
        facilityId,
        customerId,
        items: [{ productId, quantity: 1 }],
        paymentMethod: 'pending',
      })
      .expect(201);
    expect(later.body.status).toBe('pending');
    const laterInvoice = await db.invoice.findUniqueOrThrow({
      where: { id: later.body.invoiceId },
    });
    expect(laterInvoice.status).toBe('issued');
    await http()
      .post(`/invoices/${later.body.invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: Number(laterInvoice.total), methodType: 'bank_transfer' })
      .expect(200);
    let saleStatus = 'pending';
    for (let i = 0; i < 20 && saleStatus !== 'paid'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      saleStatus = (await db.productSale.findUniqueOrThrow({ where: { id: later.body.id } }))
        .status;
    }
    expect(saleStatus).toBe('paid');

    // Pendiente sin inquilino: no se puede.
    await http()
      .post('/product-sales')
      .set(auth)
      .send({ facilityId, items: [{ productId, quantity: 1 }], paymentMethod: 'pending' })
      .expect(400);

    // Sin inquilino: factura simplificada pagada.
    const anon = await http()
      .post('/product-sales')
      .set(auth)
      .send({ facilityId, items: [{ productId, quantity: 1 }] })
      .expect(201);
    const anonInvoice = await db.invoice.findUniqueOrThrow({ where: { id: anon.body.invoiceId } });
    expect(anonInvoice).toMatchObject({ invoiceType: 'F2', status: 'paid', customerId: null });

    // Más de 400 € sin inquilino: no.
    const big = await product(owner.accessToken, facilityId, 'GRANDE', 400);
    await http()
      .post('/product-sales')
      .set(auth)
      .send({ facilityId, items: [{ productId: big, quantity: 1 }] })
      .expect(400);

    // Cancelar la venta cobrada devuelve el dinero y repone el stock.
    await http().post(`/product-sales/${cash.body.id}/cancel`).set(auth).send({}).expect(200);
    const refunded = await db.invoice.findUniqueOrThrow({ where: { id: cash.body.invoiceId } });
    expect(Number(refunded.amountRefunded)).toBeCloseTo(Number(refunded.total));
    const stock = await http().get(`/products/${productId}/stock`).set(auth).expect(200);
    // 10 − 2 (cancelada, vuelve) − 1 − 1 = 8.
    expect(stock.body[0].quantity).toBe(8);

    // El cobro automático no vuelve a cobrar las facturas de una venta.
    await db.tenant.update({ where: { id: owner.tenantId }, data: { autoChargeOnIssue: true } });
    const { AutoChargeService } = await import('../src/modules/payments/auto-charge.service');
    const res = await app
      .get(AutoChargeService)
      .processAutoCharge({ tenantId: owner.tenantId, invoiceId: laterInvoice.id });
    expect(res).toMatchObject({ charged: false });

    // Borrar un producto libera su SKU.
    await http().delete(`/products/${productId}`).set(auth).expect(204);
    await http()
      .post('/products')
      .set(auth)
      .send({ sku: 'CANDADO', name: 'Otro', price: 5 })
      .expect(201);
  });

  it('descuadres, trasteros con historial, códigos y locales borrados', async () => {
    const owner = await registerVerifiedUser(app, 'invunits');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
    });

    // «Disponible con contrato» se corrige a ocupado.
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: await createCustomer(app, owner.accessToken),
        unitId: unitIds[0],
        startDate: '2025-01-01',
        priceMonthly: 50,
        depositAmount: 0,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    await db.unit.update({ where: { id: unitIds[0]! }, data: { status: 'available' } });
    const issues = await http().get('/inventory/issues').set(auth).expect(200);
    expect(issues.body[0]).toMatchObject({ unitId: unitIds[0], expectedStatus: 'occupied' });
    await http().post(`/inventory/issues/${unitIds[0]}/fix`).set(auth).expect(200);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitIds[0]! } })).status).toBe(
      'occupied',
    );
    await http().post(`/inventory/issues/${unitIds[0]}/fix`).set(auth).expect(409);

    // Un trastero que cambió de estado pero sin contratos se puede borrar.
    await http()
      .post(`/units/${unitIds[1]}/change-status`)
      .set(auth)
      .send({ status: 'maintenance' })
      .expect(200);
    await http().delete(`/units/${unitIds[1]}`).set(auth).expect(204);

    // Códigos sin distinguir mayúsculas.
    const u = await db.unit.findUniqueOrThrow({ where: { id: unitIds[2]! } });
    const dup = await http()
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId: u.unitTypeId,
        code: u.code.toLowerCase() === u.code ? u.code.toUpperCase() : u.code.toLowerCase(),
        widthM: 1,
        depthM: 1,
        heightM: 2,
      });
    expect(dup.status).toBe(409);

    // Trastero ↔ vivienda con contrato en vigor: no.
    await db.tenantFeatureOverride.create({
      data: { tenantId: owner.tenantId, feature: 'housing', enabled: true, source: 'manual' },
    });
    const housing = await http()
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Piso', defaultPriceMonthly: 500, propertyKind: 'housing' })
      .expect(201);
    await http()
      .patch(`/units/${unitIds[0]}`)
      .set(auth)
      .send({ unitTypeId: housing.body.id })
      .expect(400);

    // Horario imposible y toque de queda de 0 horas.
    await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ openingHours: { mon: { open: '20:00', close: '09:00' } } })
      .expect(400);
    await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ accessCurfewEnabled: true, accessCurfewStart: '02:00', accessCurfewEnd: '02:00' })
      .expect(400);

    // Un local borrado se lleva sus trasteros del panel.
    const other = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Para borrar',
      typeName: 'Tipo borrar',
      unitsCount: 2,
    });
    await http().delete(`/facilities/${other.facilityId}`).set(auth).expect(204);
    const list = await http().get('/units').set(auth).expect(200);
    expect(
      (list.body.items as { facilityId: string }[]).some((x) => x.facilityId === other.facilityId),
    ).toBe(false);
    await http().get(`/units/${other.unitIds[0]}`).set(auth).expect(404);
    const occ = await http().get('/dashboard/occupancy').set(auth).expect(200);
    expect(occ.body.totalUnits).toBe(2);
  });

  it('la reserva online no ofrece tipos ni locales desactivados', async () => {
    const owner = await registerVerifiedUser(app, 'invbook');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const body = {
      facilityId,
      unitTypeId,
      startDate: '2026-05-01',
      customer: {
        phone: '600000000',
        documentNumber: '12345678Z',
        firstName: 'Ana',
        lastName: 'Ruiz',
        email: `inv-${Date.now()}@e2e.local`,
      },
    };
    await http().patch(`/unit-types/${unitTypeId}`).set(auth).send({ isActive: false }).expect(200);
    await http().post(`/public/move-in/book/${owner.slug}`).send(body).expect(409);
    await http().patch(`/unit-types/${unitTypeId}`).set(auth).send({ isActive: true }).expect(200);
    await http().patch(`/facilities/${facilityId}`).set(auth).send({ isActive: false }).expect(200);
    const res = await http().post(`/public/move-in/book/${owner.slug}`).send(body);
    expect(res.status).toBe(404);
  });

  it('plantas y stock respetan el alcance por local', async () => {
    const owner = await registerVerifiedUser(app, 'invscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'TA',
      unitsCount: 1,
    });
    const b = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'TB',
      unitsCount: 1,
    });
    const productId = await product(owner.accessToken, a.facilityId, 'CAJA');

    const email = `inv-staff-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(ownerAuth).send({ email, role: 'manager' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Gestor A', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((x) => x.email === email)!;
    await http()
      .patch(`/settings/users/${staff.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [a.facilityId] })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    await http().get(`/facilities/${b.facilityId}/floors`).set(auth).expect(403);
    await http()
      .post(`/facilities/${b.facilityId}/floors`)
      .set(auth)
      .send({ name: 'Sótano', floorNumber: -1 })
      .expect(403);
    await http().patch(`/floors/${b.floorId}`).set(auth).send({ name: 'X' }).expect(403);
    await http()
      .put(`/products/${productId}/stock`)
      .set(auth)
      .send({ facilityId: b.facilityId, quantity: 5 })
      .expect(403);
    const stock = await http().get(`/products/${productId}/stock`).set(auth).expect(200);
    expect(stock.body.every((s: { facilityId: string }) => s.facilityId === a.facilityId)).toBe(
      true,
    );
    // Un local que no existe (o de otra empresa) no se acepta.
    await http()
      .put(`/products/${productId}/stock`)
      .set(ownerAuth)
      .send({ facilityId: '00000000-0000-7000-8000-000000000000', quantity: 5 })
      .expect(404);
  });
});
