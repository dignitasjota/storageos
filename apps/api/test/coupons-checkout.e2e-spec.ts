import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Cupones en la reserva online, la firma y el portal (e2e)', () => {
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
  const customer = (n: string) => ({
    firstName: 'Ana',
    lastName: 'Ruiz',
    email: `ana-${n}-${Date.now()}@e2e.local`,
    phone: '600111222',
    documentNumber: '12345678Z',
  });

  it('reserva online con cupón: resumen, reserva, firma y factura', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-book');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await http().post('/coupons').set(a).send({
      code: 'TRESXDOS',
      name: 'Tres por dos',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId };

    // Resumen: 3 meses, uno gratis → 100 € + IVA.
    const quote = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 3, couponCode: 'tresxdos' });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      months: 3,
      rentSubtotal: 150,
      discountAmount: 50,
      freeMonths: 1,
      rentTotal: 100,
      rentTotalWithVat: 121,
      prorated: false,
      coupon: { code: 'TRESXDOS', valid: true, message: null },
    });
    const short = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, couponCode: 'TRESXDOS' });
    expect(short.body).toMatchObject({
      rentTotal: 50,
      prorated: true,
      coupon: { valid: false, message: 'Este cupón es a partir de 3 meses pagados por adelantado' },
    });

    // Un cupón que no vale no reserva nada.
    const bad = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        ...base,
        startDate: '2026-03-15',
        customer: customer('bad'),
        months: 1,
        couponCode: 'TRESXDOS',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('coupon_not_valid');
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    expect(avail.body.facilities[0].unitTypes[0].available).toBe(2);

    const booked = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        ...base,
        startDate: '2026-03-15',
        customer: customer('ok'),
        months: 3,
        couponCode: 'TRESXDOS',
      });
    expect(booked.status).toBe(201);
    const token = booked.body.signingToken as string;

    // La firma enseña lo que se paga al activar.
    const view = await http().get(`/public/move-in/sign/${token}`);
    expect(view.body.firstPayment).toMatchObject({
      months: 3,
      freeMonths: 1,
      rentTotalWithVat: 121,
      totalToPay: 121,
      coupon: { code: 'TRESXDOS', valid: true },
    });
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({ signerName: 'Ana Ruiz', method: 'typed', typedSignature: 'Ana Ruiz', accept: true })
      .expect(201);
    const invoices = await http().get('/invoices').set(a);
    const inv = (invoices.body as { total: number; periodEnd: string; kind?: string }[]).find(
      (i) => i.periodEnd === '2026-06-14',
    );
    expect(Number(inv?.total)).toBe(121);
  });

  it('portal: resumen y contratación de otro trastero con cupón', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-portal');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 40,
    });
    await http().post('/coupons').set(a).send({
      code: 'VEINTE',
      name: 'Veinte',
      discountType: 'percentage',
      discountValue: 20,
    });
    const created = await http()
      .post('/customers')
      .set(a)
      .send({
        customerType: 'individual',
        firstName: 'Leo',
        lastName: 'Paz',
        email: `leo-${Date.now()}@e2e.local`,
      });
    const customerId = created.body.id as string;
    const first = await http()
      .post('/contracts')
      .set(a)
      .send({ customerId, unitId: fac.unitIds[0], priceMonthly: 40, startDate: '2026-01-01' });
    await http().post(`/contracts/${first.body.id}/sign`).set(a).send({}).expect(200);

    const link = await http().post(`/customers/${customerId}/portal-link`).set(a);
    const t = new URL(link.body.url).searchParams.get('token')!;
    const consume = await http().post('/portal/login/consume').send({ token: t });
    const portal = auth(consume.body.accessToken as string);

    const quote = await http()
      .post(`/portal/me/units/${fac.unitIds[1]}/quote`)
      .set(portal)
      .send({ months: 6, couponCode: 'VEINTE' });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ rentSubtotal: 240, discountAmount: 48, rentTotal: 192 });

    const booked = await http()
      .post('/portal/me/contracts')
      .set(portal)
      .send({ unitId: fac.unitIds[1], signerName: 'Leo Paz', months: 6, couponCode: 'VEINTE' });
    expect(booked.status).toBe(201);
    const detail = await http().get(`/invoices/${booked.body.invoiceId}`).set(a);
    expect(Number(detail.body.subtotal)).toBe(192);
    const contract = await http().get(`/contracts/${booked.body.contractId}`).set(a);
    expect(contract.body.coupon).toMatchObject({ code: 'VEINTE', months: 6, discountAmount: 48 });
  });
});
