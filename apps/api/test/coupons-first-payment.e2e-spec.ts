import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

describe('Cupones en el primer pago (e2e)', () => {
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

  async function contractInvoices(token: string, contractId: string) {
    const list = await http().get('/invoices').set(auth(token));
    const mine = (list.body as { id: string; contractId: string | null; kind?: string }[]).filter(
      (i) => i.contractId === contractId,
    );
    return Promise.all(
      mine.map(async (i) => (await http().get(`/invoices/${i.id}`).set(auth(token))).body),
    );
  }

  it('contrata 3 meses y paga 2; después factura mes a mes', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-pay');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await http().post('/coupons').set(a).send({
      code: 'TRESXDOS',
      name: 'Tres por dos',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
    });

    const created = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-03-15',
      priceMonthly: 50,
      depositAmount: 0,
      firstPaymentMonths: 3,
      couponCode: 'tresxdos',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      firstPaymentMonths: 3,
      coupon: { code: 'TRESXDOS', months: 3, freeMonths: 1, discountAmount: 50 },
    });
    const contractId = created.body.id as string;

    // Al firmar sale la 1ª factura: 3 meses completos, uno de ellos gratis.
    await http().post(`/contracts/${contractId}/sign`).set(a).expect(200);
    const [first] = await contractInvoices(owner.accessToken, contractId);
    expect(first).toMatchObject({
      status: 'issued',
      periodStart: '2026-03-15',
      periodEnd: '2026-06-14',
    });
    const items = first.items as InvoiceItem[];
    expect(items).toHaveLength(2);
    expect(Number(items[0]!.unitPrice)).toBe(100);
    expect(items[1]).toMatchObject({ quantity: 1 });
    expect(Number(items[1]!.unitPrice)).toBe(0);
    expect(items[1]!.description).toContain('cupón TRESXDOS');
    expect(Number(first.total)).toBe(121);

    const signed = await http().get(`/contracts/${contractId}`).set(a);
    expect(signed.body.billingStartsOn).toBe('2026-06-15');
    const uses = await app.get(PrismaAdminService).couponRedemption.findFirst({
      where: { contractId },
    });
    expect(uses?.invoiceId).toBe(first.id);

    // La recurrente no vuelve a facturar abril ni mayo; junio, desde el 15.
    const billing = app.get(BillingJobsService);
    for (const [start, end] of [
      ['2026-04-01', '2026-04-30'],
      ['2026-05-01', '2026-05-31'],
      ['2026-06-01', '2026-06-30'],
    ]) {
      await billing.processGenerateRecurring({
        tenantId: owner.tenantId,
        periodStart: start!,
        periodEnd: end!,
      });
    }
    const all = await contractInvoices(owner.accessToken, contractId);
    expect(all).toHaveLength(2);
    const june = all.find((i) => i.id !== first.id);
    expect(june).toMatchObject({ periodStart: '2026-06-15', periodEnd: '2026-06-30' });
    expect(Number((june.items as InvoiceItem[])[0]!.unitPrice)).toBe(26.67);
  });

  it('porcentaje sobre un mes, el mejor descuento y liberar el cupón al cancelar', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-pct');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 40,
    });
    await http().post('/coupons').set(a).send({
      code: 'VEINTE',
      name: 'Veinte',
      discountType: 'percentage',
      discountValue: 20,
      maxUses: 5,
    });

    // 1 mes con el 20 %: la 1ª factura cubre un mes completo desde el alta.
    const c1 = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-03-10',
      priceMonthly: 40,
      depositAmount: 0,
      couponCode: 'VEINTE',
    });
    expect(c1.status).toBe(201);
    await http().post(`/contracts/${c1.body.id}/sign`).set(a).expect(200);
    const [inv] = await contractInvoices(owner.accessToken, c1.body.id);
    expect(inv).toMatchObject({ periodStart: '2026-03-10', periodEnd: '2026-04-09' });
    expect(Number((inv.items as InvoiceItem[])[0]!.unitPrice)).toBe(32);

    // No se combina con un código promocional.
    const both = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[1],
      startDate: '2026-03-10',
      priceMonthly: 40,
      couponCode: 'VEINTE',
      promotionCode: 'OTRO',
    });
    expect(both.status).toBe(400);
    expect(both.body.code).toBe('coupon_with_promotion');

    // Prepago anual con un 25 % de descuento: el cupón (20 %) no mejora.
    const worse = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[1],
      startDate: '2026-03-10',
      priceMonthly: 40,
      billingIntervalMonths: 12,
      prepayDiscountPct: 25,
      couponCode: 'VEINTE',
    });
    expect(worse.status).toBe(400);
    expect(worse.body.code).toBe('coupon_not_better');

    // Un borrador cancelado devuelve el uso del cupón.
    const before = (await http().get('/coupons').set(a)).body[0].usedCount as number;
    const draft = await http().post('/contracts').set(a).send({
      customerId,
      unitId: unitIds[2],
      startDate: '2026-03-10',
      priceMonthly: 40,
      couponCode: 'VEINTE',
    });
    expect(draft.status).toBe(201);
    expect((await http().get('/coupons').set(a)).body[0].usedCount).toBe(before + 1);
    await http()
      .post(`/contracts/${draft.body.id}/cancel`)
      .set(a)
      .send({ reason: 'No sigue' })
      .expect(200);
    expect((await http().get('/coupons').set(a)).body[0].usedCount).toBe(before);
  });
});
