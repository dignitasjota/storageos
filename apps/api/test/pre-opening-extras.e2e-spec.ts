import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { PreOpeningService } from '../src/modules/contracts/pre-opening.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const today = () => todayInTimezone('Europe/Madrid').toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n))
    .toISOString()
    .slice(0, 10);

/**
 * Reservas antes de la apertura: cupón de preapertura, «Hoy», preventa en
 * Analítica y trastero fuera de servicio el día de apertura.
 */
describe('Reservas antes de la apertura: extras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
    });
    await http()
      .put(`/facilities/${facilityId}/opening`)
      .set(auth)
      .send({ preOpening: true, openingDate: addDays(today(), 5), maxMonths: 6 })
      .expect(200);
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`).expect(200);
    return { owner, auth, facilityId, unitTypeId: avail.body.facilities[0].unitTypes[0].id };
  }

  async function book(ctx: Awaited<ReturnType<typeof setup>>, couponCode?: string) {
    const res = await http()
      .post(`/public/move-in/book/${ctx.owner.slug}`)
      .send({
        facilityId: ctx.facilityId,
        unitTypeId: ctx.unitTypeId,
        startDate: today(),
        ...(couponCode ? { couponCode } : {}),
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Ana',
          lastName: 'Sanz',
          email: `pox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
        },
      })
      .expect(201);
    await http()
      .post(`/public/move-in/sign/${res.body.signingToken}`)
      .send({ signerName: 'Ana Sanz', method: 'typed', typedSignature: 'Ana Sanz', accept: true })
      .expect(201);
    return res.body.contractId as string;
  }

  it('cupón de preapertura: solo en el local por abrir y descuenta la primera mensualidad', async () => {
    const ctx = await setup('poxcoupon');
    await http()
      .post('/coupons')
      .set(ctx.auth)
      .send({
        code: 'PREAPERTURA',
        name: 'Preapertura',
        discountType: 'percentage',
        discountValue: 50,
        preOpeningOnly: true,
      })
      .expect(201);
    const quote = await http()
      .post(`/public/move-in/book/${ctx.owner.slug}/quote`)
      .send({ facilityId: ctx.facilityId, unitTypeId: ctx.unitTypeId, couponCode: 'PREAPERTURA' })
      .expect(200);
    expect(quote.body).toMatchObject({
      preOpening: true,
      months: 1,
      discountAmount: 25,
      coupon: { valid: true },
    });
    const contractId = await book(ctx, 'PREAPERTURA');
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
    });
    // 50 € − 50 % = 25 € + IVA.
    expect(Number(invoice.total)).toBe(30.25);

    // Con el local abierto, el cupón ya no vale.
    await http()
      .put(`/facilities/${ctx.facilityId}/opening`)
      .set(ctx.auth)
      .send({ preOpening: false, openingDate: null, maxMonths: 6 })
      .expect(200);
    const after = await http()
      .post(`/public/move-in/book/${ctx.owner.slug}/quote`)
      .send({ facilityId: ctx.facilityId, unitTypeId: ctx.unitTypeId, couponCode: 'PREAPERTURA' })
      .expect(200);
    expect(after.body.coupon).toMatchObject({ valid: false });
  });

  it('«Hoy», preventa y trastero fuera de servicio el día de apertura', async () => {
    const ctx = await setup('poxopen');
    const contractId = await book(ctx);
    const today_ = await http().get('/dashboard/today').set(ctx.auth).expect(200);
    expect(today_.body.preOpeningSoon.count).toBe(1);
    expect(today_.body.preOpeningSoon.items[0].detail).toContain('1 reserva');
    expect(today_.body.preOpeningSoon.items[0].detail).toContain('1 sin pagar');

    const analytics = await http().get('/analytics/pre-opening').set(ctx.auth).expect(200);
    expect(analytics.body.facilities).toHaveLength(1);
    expect(analytics.body.facilities[0]).toMatchObject({
      totalUnits: 3,
      reserved: 1,
      unpaid: 1,
      available: 2,
      reservedMrr: 50,
    });

    // El trastero reservado pasa a mantenimiento antes de abrir.
    const c = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    await admin.unit.update({ where: { id: c.unitId }, data: { status: 'maintenance' } });
    await admin.facility.update({
      where: { id: ctx.facilityId },
      data: { openingDate: new Date(`${today()}T00:00:00Z`) },
    });
    await app.get(PreOpeningService).runDue();
    const started = await admin.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { unit: true },
    });
    expect(started.preOpeningStartedAt).not.toBeNull();
    expect(started.unitId).not.toBe(c.unitId);
    expect(started.unit.status).toBe('occupied');
    expect(
      await admin.contractEvent.count({
        where: { contractId, payload: { path: ['kind'], equals: 'pre_opening_reassigned' } },
      }),
    ).toBe(1);
    const after = await http().get('/dashboard/today').set(ctx.auth).expect(200);
    expect(after.body.preOpeningSoon.count).toBe(0);
  });
});
