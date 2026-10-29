import { BadRequestException } from '@nestjs/common';
import request from 'supertest';

import { CouponsService } from '../src/modules/coupons/coupons.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Cupones: casos límite (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
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

  it('cupón del 100 %: el alquiler queda saldado y solo se paga la fianza', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-zero');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await admin.unitType.update({
      where: { id: fac.unitTypeId },
      data: { defaultDepositAmount: 60 },
    });
    await http().post('/coupons').set(a).send({
      code: 'GRATIS',
      name: 'Primer mes gratis',
      discountType: 'percentage',
      discountValue: 100,
    });

    const booked = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: '2026-03-15',
        customer: customer('zero'),
        months: 1,
        couponCode: 'GRATIS',
      });
    expect(booked.status).toBe(201);
    const signed = await http()
      .post(`/public/move-in/sign/${booked.body.signingToken}`)
      .send({
        signerName: 'Ana Ruiz',
        method: 'typed',
        typedSignature: 'Ana Ruiz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booked.body.signingToken),
      });
    expect(signed.status).toBe(201);

    const contractId = booked.body.contractId as string;
    const docs = await admin.invoice.findMany({
      where: { contractId },
      select: { kind: true, status: true, total: true },
    });
    const rent = docs.find((d) => d.kind === 'invoice');
    const deposit = docs.find((d) => d.kind === 'deposit_receipt');
    expect(rent).toMatchObject({ status: 'paid' });
    expect(Number(rent!.total)).toBe(0);
    expect(deposit).toMatchObject({ status: 'issued' });

    // En el portal la fianza se paga sola (ya no va «con» la factura saldada).
    const portal = auth(signed.body.portalToken as string);
    const list = await http().get('/portal/me/invoices').set(portal);
    const receipt = (
      list.body as { kind: string; amountPending: number; paidWithInvoiceId: string | null }[]
    ).find((i) => i.kind === 'deposit_receipt');
    expect(receipt).toMatchObject({ amountPending: 60, paidWithInvoiceId: null });

    // Con el alquiler saldado, la reserva no caduca.
    await admin.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();
    const after = await admin.contract.findUnique({ where: { id: contractId } });
    expect(after!.status).toBe('active');

    // Y si se cancela después, el uso del cupón no se devuelve (ya se disfrutó).
    await http()
      .post(`/contracts/${contractId}/cancel`)
      .set(a)
      .send({ reason: 'prueba' })
      .expect(200);
    const coupon = await admin.coupon.findFirst({ where: { code: 'GRATIS' } });
    expect(coupon!.usedCount).toBe(1);
  });

  it('web pública: no dice si un código existe y no deja clientes sueltos', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-public');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await http().post('/coupons').set(a).send({
      code: 'CADUCADO',
      name: 'Caducado',
      discountType: 'percentage',
      discountValue: 10,
      validFrom: '2025-01-01T00:00:00.000Z',
      validUntil: '2025-02-01T00:00:00.000Z',
    });
    await http().post('/coupons').set(a).send({
      code: 'DIEZ',
      name: 'Diez',
      discountType: 'percentage',
      discountValue: 10,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId, months: 1 };
    for (const code of ['NOEXISTE', 'CADUCADO']) {
      const q = await http()
        .post(`/public/move-in/book/${owner.slug}/quote`)
        .send({ ...base, couponCode: code });
      expect(q.body.coupon).toMatchObject({ valid: false, message: 'Este cupón no es válido' });
    }

    // Si el contrato no se crea, el cliente nuevo no se queda guardado.
    const data = customer('fail');
    jest
      .spyOn(app.get(CouponsService), 'redeemInTx')
      .mockRejectedValueOnce(new BadRequestException({ code: 'coupon_max_uses_reached' }));
    const res = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({ ...base, startDate: '2026-03-15', customer: data, couponCode: 'DIEZ' });
    expect(res.status).toBe(400);
    expect(await admin.customer.count({ where: { email: data.email } })).toBe(0);
    expect((await admin.unit.findUnique({ where: { id: fac.unitIds[0] } }))!.status).toBe(
      'available',
    );
  });

  it('un uso por cliente y sin sumar un descuento manual', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-once');
    const a = auth(owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 50,
    });
    await http().post('/coupons').set(a).send({
      code: 'UNAVEZ',
      name: 'Una vez',
      discountType: 'percentage',
      discountValue: 10,
      oncePerCustomer: true,
    });
    const contract = (unitId: string, extra: Record<string, unknown> = {}) =>
      http()
        .post('/contracts')
        .set(a)
        .send({ customerId, unitId, startDate: '2026-03-15', priceMonthly: 50, ...extra });

    const withDiscount = await contract(unitIds[0]!, { couponCode: 'UNAVEZ', discountAmount: 5 });
    expect(withDiscount.status).toBe(400);
    expect(withDiscount.body.code).toBe('coupon_with_discount');

    const first = await contract(unitIds[0]!, { couponCode: 'UNAVEZ' });
    expect(first.status).toBe(201);
    const patch = await http()
      .patch(`/contracts/${first.body.id}`)
      .set(a)
      .send({ discountAmount: 5 });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('coupon_with_discount');

    const second = await contract(unitIds[1]!, { couponCode: 'UNAVEZ' });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('coupon_already_used');
    const check = await http()
      .post('/coupons/validate')
      .set(a)
      .send({ code: 'UNAVEZ', unitId: unitIds[2], months: 1, customerId });
    expect(check.body).toMatchObject({ valid: false, reason: 'already_used' });
  });
});
