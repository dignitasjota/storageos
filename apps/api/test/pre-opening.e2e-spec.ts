import { addMonthsYmd } from '@storageos/shared';
import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reservas antes de la apertura: el cliente paga la primera mensualidad y la
 * fianza; el alquiler (acceso y facturación) empieza el día que abre el local.
 */
describe('Reservas antes de la apertura (e2e)', () => {
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

  async function setup(suffix: string, openingDate: string | null) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
    });
    await admin.unitType.updateMany({
      where: { tenantId: owner.tenantId },
      data: { defaultDepositAmount: 60 },
    });
    const opening = await request(app.getHttpServer())
      .put(`/facilities/${facilityId}/opening`)
      .set(auth)
      .send({ preOpening: true, openingDate, maxMonths: 6 })
      .expect(200);
    expect(opening.body).toMatchObject({ preOpening: true, openingDate, maxMonths: 6 });
    const avail = await request(app.getHttpServer())
      .get(`/public/move-in/book/${owner.slug}/availability`)
      .expect(200);
    const facility = avail.body.facilities[0];
    expect(facility).toMatchObject({ preOpening: true, openingDate });
    return { owner, auth, facilityId, unitTypeId: facility.unitTypes[0].id as string };
  }

  async function bookAndPay(ctx: Awaited<ReturnType<typeof setup>>) {
    const quote = await request(app.getHttpServer())
      .post(`/public/move-in/book/${ctx.owner.slug}/quote`)
      .send({ facilityId: ctx.facilityId, unitTypeId: ctx.unitTypeId, months: 3 })
      .expect(200);
    // Una mensualidad completa (50 € + IVA) y la fianza, sin prorrateo.
    expect(quote.body).toMatchObject({ preOpening: true, months: 1, prorated: false });
    expect(quote.body.totalToPay).toBe(120.5);
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${ctx.owner.slug}`)
      .send({
        facilityId: ctx.facilityId,
        unitTypeId: ctx.unitTypeId,
        startDate: today(),
        months: 3,
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Ana',
          lastName: 'Sanz',
          email: `po-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
        },
      })
      .expect(201);
    const token = booking.body.signingToken as string;
    const view = await request(app.getHttpServer())
      .get(`/public/move-in/sign/${token}`)
      .expect(200);
    expect(view.body.termsText).toContain('Reserva antes de la apertura del local');
    expect(view.body.termsText).toContain('arras penitenciales');
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${token}`)
      .send({ signerName: 'Ana Sanz', method: 'typed', typedSignature: 'Ana Sanz', accept: true })
      .expect(201);
    const contractId = booking.body.contractId as string;
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      include: { items: true },
    });
    expect(invoice.periodStart).toBeNull();
    expect(Number(invoice.total)).toBe(60.5);
    const receipt = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'deposit_receipt' },
    });
    for (const inv of [invoice, receipt]) {
      await request(app.getHttpServer())
        .post(`/invoices/${inv.id}/mark-paid`)
        .set(ctx.auth)
        .send({ amount: Number(inv.total), methodType: 'cash' })
        .expect(200);
    }
    await wait(300);
    return { contractId, invoiceId: invoice.id };
  }

  it('reserva, cambio de fecha y apertura: acceso y facturación desde ese día', async () => {
    const ctx = await setup('preopen', addDays(today(), 40));
    const { contractId } = await bookAndPay(ctx);

    let contract = await admin.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { unit: true },
    });
    expect(contract.preOpening).toBe(true);
    expect(contract.unit.status).toBe('reserved');
    expect(contract.startDate.toISOString().slice(0, 10)).toBe(addDays(today(), 40));
    // Pagado, pero aún sin acceso.
    expect(await admin.accessCredential.count({ where: { customerId: contract.customerId } })).toBe(
      0,
    );

    // La recurrente no la factura mientras no abre.
    await app.get(BillingJobsService).processGenerateRecurring({
      tenantId: ctx.owner.tenantId,
      periodStart: today().slice(0, 8) + '01',
      periodEnd: addDays(today(), 60),
    });
    expect(await admin.invoice.count({ where: { contractId, kind: 'invoice' } })).toBe(1);

    // Otra fecha: la reserva se mueve. Sin fecha: vuelve a la fecha límite.
    const moved = await request(app.getHttpServer())
      .put(`/facilities/${ctx.facilityId}/opening`)
      .set(ctx.auth)
      .send({ preOpening: true, openingDate: null, maxMonths: 6 })
      .expect(200);
    expect(moved.body).toMatchObject({ moved: 1, reservations: 1 });
    contract = await admin.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { unit: true },
    });
    expect(contract.preOpeningDateConfirmed).toBe(false);
    expect(contract.startDate.toISOString()).toBe(contract.preOpeningDeadline!.toISOString());

    // Cambio de trastero: solo uno del mismo precio.
    const other = await admin.unit.findFirstOrThrow({
      where: { tenantId: ctx.owner.tenantId, status: 'available' },
    });
    await admin.unit.update({ where: { id: other.id }, data: { basePriceMonthly: 70 } });
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/change-unit`)
      .set(ctx.auth)
      .send({ newUnitId: other.id })
      .expect(400);
    await admin.unit.update({ where: { id: other.id }, data: { basePriceMonthly: 50 } });
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/change-unit`)
      .set(ctx.auth)
      .send({ newUnitId: other.id })
      .expect(200);
    expect((await admin.unit.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'reserved',
    );

    // Abre hoy: empieza.
    const opened = await request(app.getHttpServer())
      .put(`/facilities/${ctx.facilityId}/opening`)
      .set(ctx.auth)
      .send({ preOpening: true, openingDate: today(), maxMonths: 6 })
      .expect(200);
    expect(opened.body).toMatchObject({ started: 1, preOpening: false });
    await wait(500);
    contract = await admin.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { unit: true },
    });
    expect(contract.preOpeningStartedAt).not.toBeNull();
    expect(contract.unit.status).toBe('occupied');
    expect(contract.billingStartsOn?.toISOString().slice(0, 10)).toBe(addMonthsYmd(today(), 1));
    expect(
      await admin.accessCredential.count({
        where: { customerId: contract.customerId, status: 'active' },
      }),
    ).toBe(1);
    const detail = await request(app.getHttpServer())
      .get(`/contracts/${contractId}`)
      .set(ctx.auth)
      .expect(200);
    expect(detail.body.preOpening.startedAt).not.toBeNull();
  });

  it('cancelar: dentro de 14 días devuelve todo; después retiene la fianza', async () => {
    const ctx = await setup('precancel', null);
    const first = await bookAndPay(ctx);
    const preview = await request(app.getHttpServer())
      .get(`/contracts/${first.contractId}/pre-opening/cancel-preview`)
      .set(ctx.auth)
      .expect(200);
    expect(preview.body).toMatchObject({
      reason: 'withdrawal',
      refundRent: true,
      refundDeposit: true,
      rentAmount: 60.5,
      depositAmount: 60,
    });
    await request(app.getHttpServer())
      .post(`/contracts/${first.contractId}/cancel-pre-opening`)
      .set(ctx.auth)
      .send({})
      .expect(200);
    let c = await admin.contract.findUniqueOrThrow({
      where: { id: first.contractId },
      include: { unit: true },
    });
    expect(c.status).toBe('cancelled');
    expect(c.unit.status).toBe('available');
    expect(c.depositStatus).toBe('returned');
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: first.invoiceId } });
    expect(Number(inv.amountRefunded)).toBe(60.5);

    // Firmada hace 20 días: se devuelve la mensualidad y se retiene la fianza.
    const second = await bookAndPay(ctx);
    await admin.contract.update({
      where: { id: second.contractId },
      data: { signedAt: new Date(Date.now() - 20 * 86_400_000) },
    });
    const later = await request(app.getHttpServer())
      .get(`/contracts/${second.contractId}/pre-opening/cancel-preview`)
      .set(ctx.auth)
      .expect(200);
    expect(later.body).toMatchObject({ reason: 'standard', refundDeposit: false });
    await request(app.getHttpServer())
      .post(`/contracts/${second.contractId}/cancel-pre-opening`)
      .set(ctx.auth)
      .send({})
      .expect(200);
    c = await admin.contract.findUniqueOrThrow({
      where: { id: second.contractId },
      include: { unit: true },
    });
    expect(c.depositStatus).toBe('partially_returned');
    expect(Number(c.depositReturnedAmount)).toBe(0);
    expect(c.depositRetentionReason).toContain('arras');
  });

  it('plazo vencido, arranque tras un fallo y reservas sin firmar al abrir', async () => {
    const ctx = await setup('prereview', addDays(today(), 40));
    const signed = await bookAndPay(ctx);
    // Reserva online: la primera mensualidad vence a los 3 días.
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: signed.invoiceId } });
    expect(inv.dueDate?.toISOString().slice(0, 10)).toBe(
      addDays(new Date().toISOString().slice(0, 10), 3),
    );
    // Sin empezar: ni baja ni renovación (se cancela como reserva).
    const endRes = await request(app.getHttpServer())
      .post(`/contracts/${signed.contractId}/request-end`)
      .set(ctx.auth)
      .send({})
      .expect(400);
    expect(endRes.body.code).toBe('pre_opening_not_started');

    // Otra reserva que se queda sin firmar.
    const draft = await request(app.getHttpServer())
      .post(`/public/move-in/book/${ctx.owner.slug}`)
      .send({
        facilityId: ctx.facilityId,
        unitTypeId: ctx.unitTypeId,
        startDate: today(),
        customer: {
          phone: '600000001',
          documentNumber: '87654321X',
          firstName: 'Luis',
          lastName: 'Gil',
          email: `po-d-${Date.now()}@e2e.local`,
        },
      })
      .expect(201);

    // Plazo vencido: se avisa una vez.
    await admin.contract.update({
      where: { id: signed.contractId },
      data: { preOpeningDeadline: new Date(`${addDays(today(), -2)}T00:00:00Z`) },
    });
    const service = app.get(PreOpeningService);
    expect((await service.runDue()).expired).toBeGreaterThanOrEqual(1);
    let c = await admin.contract.findUniqueOrThrow({ where: { id: signed.contractId } });
    expect(c.preOpeningDeadlineNotifiedAt).not.toBeNull();
    expect(
      await admin.notification.count({
        where: { tenantId: ctx.owner.tenantId, type: 'contract.pre_opening_deadline_passed' },
      }),
    ).toBe(1);
    await service.runDue();
    expect(
      await admin.notification.count({
        where: { tenantId: ctx.owner.tenantId, type: 'contract.pre_opening_deadline_passed' },
      }),
    ).toBe(1);

    // El local quedó abierto sin arrancar sus reservas (fallo a medias): el
    // cron las arranca.
    await admin.facility.update({
      where: { id: ctx.facilityId },
      data: { preOpening: false, openingDate: new Date(`${today()}T00:00:00Z`) },
    });
    expect((await service.runDue()).started).toBe(2);
    c = await admin.contract.findUniqueOrThrow({ where: { id: signed.contractId } });
    expect(c.preOpeningStartedAt).not.toBeNull();
    // La reserva sin firmar pasa a ser un alta normal desde la apertura.
    const d = await admin.contract.findUniqueOrThrow({ where: { id: draft.body.contractId } });
    expect(d.preOpening).toBe(false);
    expect(d.startDate.toISOString().slice(0, 10)).toBe(today());
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${draft.body.signingToken}`)
      .send({ signerName: 'Luis Gil', method: 'typed', typedSignature: 'Luis Gil', accept: true })
      .expect(201);
    const first = await admin.invoice.findFirstOrThrow({
      where: { contractId: draft.body.contractId, kind: 'invoice' },
    });
    expect(first.periodStart?.toISOString().slice(0, 10)).toBe(today());
  });
});
