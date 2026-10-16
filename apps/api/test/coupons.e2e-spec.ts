import request from 'supertest';

import { CouponsService } from '../src/modules/coupons/coupons.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PrismaService } from '../src/modules/database/prisma.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Cupones (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('crea cupones con condiciones y calcula el pago con cada uno', async () => {
    const owner = await registerVerifiedUser(app, 'coupons');
    const a = auth(owner.accessToken);
    const big = await createFacilityWithUnits(app, owner.accessToken, {
      typeName: 'Grande',
      unitsCount: 1,
      pricePerUnit: 50,
    });
    const small = await createFacilityWithUnits(app, owner.accessToken, {
      typeName: 'Pequeño',
      unitsCount: 1,
      pricePerUnit: 30,
    });

    // «Contrata 3 meses, paga 2», solo para el tipo grande.
    const free = await http()
      .post('/coupons')
      .set(a)
      .send({
        code: 'tres-por-dos',
        name: 'Tres por dos',
        discountType: 'free_months',
        discountValue: 1,
        minMonths: 3,
        unitTypeIds: [big.unitTypeId],
      });
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({ code: 'TRES-POR-DOS', minMonths: 3, usedCount: 0 });

    const ok = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'tres-por-dos', unitId: big.unitIds[0], months: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      valid: true,
      rentSubtotal: 150,
      freeMonths: 1,
      discountAmount: 50,
      rentTotal: 100,
    });

    const short = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'TRES-POR-DOS', unitId: big.unitIds[0], months: 1 });
    expect(short.body).toMatchObject({ valid: false, reason: 'min_months' });

    const otherType = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'TRES-POR-DOS', unitId: small.unitIds[0], months: 3 });
    expect(otherType.body).toMatchObject({ valid: false, reason: 'unit_type' });

    // 20 % sobre la cuota pactada (no la del trastero), con importe mínimo.
    const pct = await http().post('/coupons').set(a).send({
      code: 'VEINTE',
      name: 'Veinte',
      discountType: 'percentage',
      discountValue: 20,
      minAmount: 100,
    });
    expect(pct.status).toBe(201);
    const pctQuote = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'VEINTE', unitId: small.unitIds[0], months: 12, monthlyPrice: 40 });
    expect(pctQuote.body).toMatchObject({ valid: true, rentSubtotal: 480, discountAmount: 96 });
    const low = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'VEINTE', unitId: small.unitIds[0], months: 1 });
    expect(low.body).toMatchObject({ valid: false, reason: 'min_amount' });

    const missing = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'NOEXISTE', unitId: small.unitIds[0], months: 1 });
    expect(missing.body).toMatchObject({ valid: false, reason: 'not_found' });

    // Código repetido, meses gratis sin pagar ninguno, tipo de otro tenant.
    const dup = await http()
      .post('/coupons')
      .set(a)
      .send({ code: 'VEINTE', name: 'x', discountType: 'fixed', discountValue: 5 });
    expect(dup.status).toBe(409);
    const allFree = await http()
      .post('/coupons')
      .set(a)
      .send({ code: 'GRATIS', name: 'x', discountType: 'free_months', discountValue: 2 });
    expect(allFree.status).toBe(400);
    const other = await registerVerifiedUser(app, 'coupons-other');
    const foreign = await createFacilityWithUnits(app, other.accessToken, { unitsCount: 1 });
    const badScope = await http()
      .post('/coupons')
      .set(a)
      .send({
        code: 'AJENO',
        name: 'x',
        discountType: 'fixed',
        discountValue: 5,
        unitTypeIds: [foreign.unitTypeId],
      });
    expect(badScope.status).toBe(400);
    expect(badScope.body.code).toBe('invalid_scope');

    // Editar comprueba las reglas sobre el resultado.
    const badEdit = await http().patch(`/coupons/${free.body.id}`).set(a).send({ minMonths: 1 });
    expect(badEdit.status).toBe(400);
    const edit = await http()
      .patch(`/coupons/${free.body.id}`)
      .set(a)
      .send({ minMonths: 6, isActive: false });
    expect(edit.body).toMatchObject({ minMonths: 6, isActive: false });
    const inactive = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'TRES-POR-DOS', unitId: big.unitIds[0], months: 6 });
    expect(inactive.body).toMatchObject({ valid: false, reason: 'inactive' });

    const list = await http().get('/coupons').set(a);
    expect(list.body.map((c: { code: string }) => c.code).sort()).toEqual([
      'TRES-POR-DOS',
      'VEINTE',
    ]);
  });

  it('solo clientes nuevos, un uso a la vez y no se borra si ya se usó', async () => {
    const owner = await registerVerifiedUser(app, 'coupons-use');
    const a = auth(owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 40,
    });
    const created = await http().post('/coupons').set(a).send({
      code: 'BIENVENIDA',
      name: 'Bienvenida',
      discountType: 'fixed',
      discountValue: 15,
      newCustomersOnly: true,
      maxUses: 1,
    });
    expect(created.status).toBe(201);

    // Un cliente con un contrato firmado ya no es nuevo.
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(a).send({
      customerId,
      unitId: fac.unitIds[0],
      startDate: '2026-07-01',
      priceMonthly: 40,
      depositAmount: 0,
    });
    expect(contract.status).toBe(201);
    const fresh = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'BIENVENIDA', unitId: fac.unitIds[1], months: 1, customerId });
    expect(fresh.body).toMatchObject({ valid: true, discountAmount: 15, rentTotal: 25 });
    await app
      .get(PrismaAdminService)
      .contract.update({ where: { id: contract.body.id }, data: { signedAt: new Date() } });
    const repeat = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'BIENVENIDA', unitId: fac.unitIds[1], months: 1, customerId });
    expect(repeat.body).toMatchObject({ valid: false, reason: 'new_customers_only' });

    // Dos usos a la vez con un máximo de 1: solo entra uno.
    const coupons = app.get(CouponsService);
    const prisma = app.get(PrismaService);
    const ctx = { monthlyPrice: 40, months: 1 };
    const redeem = () =>
      prisma.withTenant(async (tx) => {
        const r = await coupons.redeemInTx(tx, owner.tenantId, 'bienvenida', ctx);
        await coupons.recordRedemptionInTx(tx, owner.tenantId, r, {
          customerId,
          contractId: null,
          invoiceId: null,
        });
        return r;
      }, owner.tenantId);
    const results = await Promise.allSettled([redeem(), redeem()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as { response?: { code?: string } }).response?.code).toBe(
      'coupon_max_uses_reached',
    );

    const uses = await http().get(`/coupons/${created.body.id}/redemptions`).set(a);
    expect(uses.body).toHaveLength(1);
    expect(uses.body[0]).toMatchObject({ months: 1, discountAmount: 15 });

    const del = await http().delete(`/coupons/${created.body.id}`).set(a);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('coupon_in_use');
  });
});
