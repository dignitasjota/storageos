import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Primer pago mensual: desde el día que fije el negocio (20 por defecto)
 * incluye también el mes siguiente completo. El resumen que ve el inquilino
 * coincide con la factura.
 */
describe('Primer pago con el mes siguiente (e2e)', () => {
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

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    // 50 €/mes sin IVA por trastero.
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const avail = await request(app.getHttpServer())
      .get(`/public/move-in/book/${owner.slug}/availability`)
      .expect(200);
    const facility = avail.body.facilities[0];
    return { owner, auth, facilityId: facility.id, unitTypeId: facility.unitTypes[0].id };
  }

  async function book(
    ctx: Awaited<ReturnType<typeof setup>>,
    startDate: string,
  ): Promise<{ quoteTotal: number; contractId: string }> {
    const quote = await request(app.getHttpServer())
      .post(`/public/move-in/book/${ctx.owner.slug}/quote`)
      .send({ facilityId: ctx.facilityId, unitTypeId: ctx.unitTypeId, months: 1, startDate })
      .expect(200);
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${ctx.owner.slug}`)
      .send({
        facilityId: ctx.facilityId,
        unitTypeId: ctx.unitTypeId,
        startDate,
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Eva',
          lastName: 'Ruiz',
          email: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
        },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({ signerName: 'Eva Ruiz', method: 'typed', typedSignature: 'Eva Ruiz', accept: true })
      .expect(201);
    return { quoteTotal: quote.body.totalToPay, contractId: booking.body.contractId };
  }

  it('desde el día 20 incluye el mes siguiente y la recurrente no lo vuelve a facturar', async () => {
    const ctx = await setup('fpnext');
    const settings = await request(app.getHttpServer())
      .get('/settings/tenant/billing')
      .set(ctx.auth)
      .expect(200);
    expect(settings.body.firstPaymentNextMonthFromDay).toBe(20);

    const { quoteTotal, contractId } = await book(ctx, '2027-03-28');
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    // 28-31 de marzo (4/31 de 50 €) + abril entero, con IVA.
    expect(invoice.items.map((i) => Number(i.unitPrice))).toEqual([6.45, 50]);
    expect(Number(invoice.total)).toBe(68.3);
    expect(quoteTotal).toBe(68.3);
    expect(invoice.periodEnd?.toISOString().slice(0, 10)).toBe('2027-04-30');
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.billingStartsOn?.toISOString().slice(0, 10)).toBe('2027-05-01');

    // La recurrente de abril no factura otra vez; la de mayo sí.
    const jobs = app.get(BillingJobsService);
    await jobs.processGenerateRecurring({
      tenantId: ctx.owner.tenantId,
      periodStart: '2027-04-01',
      periodEnd: '2027-04-30',
    });
    expect(await admin.invoice.count({ where: { contractId, kind: 'invoice' } })).toBe(1);
    await jobs.processGenerateRecurring({
      tenantId: ctx.owner.tenantId,
      periodStart: '2027-05-01',
      periodEnd: '2027-05-31',
    });
    expect(await admin.invoice.count({ where: { contractId, kind: 'invoice' } })).toBe(2);
  });

  it('al firmar en el panel también incluye el mes siguiente', async () => {
    const ctx = await setup('fppanel');
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(ctx.auth)
      .send({
        customerType: 'individual',
        firstName: 'Luis',
        lastName: 'Gil',
        sendPortalAccess: false,
      })
      .expect(201);
    const unit = await admin.unit.findFirstOrThrow({
      where: { tenantId: ctx.owner.tenantId, status: 'available' },
    });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(ctx.auth)
      .send({
        customerId: customer.body.id,
        unitId: unit.id,
        startDate: '2027-03-25',
        priceMonthly: 50,
        billingCycle: 'monthly',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(ctx.auth)
      .send({})
      .expect(200);
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: contract.body.id, kind: 'invoice' },
    });
    expect(invoice.periodEnd?.toISOString().slice(0, 10)).toBe('2027-04-30');
  });

  it('el saldo a favor se descuenta de las dos líneas de alquiler', async () => {
    const ctx = await setup('fpcredit');
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(ctx.auth)
      .send({
        customerType: 'individual',
        firstName: 'Ana',
        lastName: 'Mas',
        sendPortalAccess: false,
      })
      .expect(201);
    const unit = await admin.unit.findFirstOrThrow({
      where: { tenantId: ctx.owner.tenantId, status: 'available' },
    });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(ctx.auth)
      .send({
        customerId: customer.body.id,
        unitId: unit.id,
        startDate: '2027-03-28',
        priceMonthly: 50,
        billingCycle: 'monthly',
      })
      .expect(201);
    // Señal de 10 € ya cobrada: más que los 6,45 € de los días de marzo.
    await admin.contract.update({
      where: { id: contract.body.id },
      data: { pendingCreditAmount: 10, pendingCreditReason: 'señal de la reserva' },
    });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(ctx.auth)
      .send({})
      .expect(200);
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: contract.body.id, kind: 'invoice' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(invoice.items.map((i) => Number(i.unitPrice))).toEqual([0, 46.45]);
    expect(invoice.items[1]?.description).toContain('descontados 3,55 €');
    const after = await admin.contract.findUniqueOrThrow({ where: { id: contract.body.id } });
    expect(Number(after.pendingCreditAmount)).toBe(0);
  });

  it('antes del día 20, o desactivado, solo los días que quedan', async () => {
    const ctx = await setup('fpprorated');
    const early = await book(ctx, '2027-03-05');
    const earlyInvoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: early.contractId, kind: 'invoice' },
    });
    // 27/31 de 50 € = 43,55 € + IVA.
    expect(Number(earlyInvoice.total)).toBe(52.7);
    expect(early.quoteTotal).toBe(52.7);

    await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(ctx.auth)
      .send({ firstPaymentNextMonthFromDay: null })
      .expect(200);
    const late = await book(ctx, '2027-03-28');
    const lateInvoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: late.contractId, kind: 'invoice' },
    });
    expect(Number(lateInvoice.total)).toBe(7.8);
    expect(late.quoteTotal).toBe(7.8);
  });
});
