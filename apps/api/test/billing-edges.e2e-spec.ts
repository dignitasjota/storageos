import { createHmac } from 'node:crypto';

import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { InvoicesService } from '../src/modules/billing/invoices.service';
import { PlatformInvoicesService } from '../src/modules/billing-saas/platform-invoices.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Ids de evento únicos por ejecución (la tabla de deduplicación es global). */
const RUN = Date.now().toString(36);

/**
 * Casos límite de facturación y cobro (auditoría de facturación, PR 7):
 * recurrente con alta/baja a mitad de mes y prepago, devolución de un solo
 * cobro, fallo tardío de GoCardless, cobro duplicado y numeración de las
 * facturas de suscripción.
 */
describe('Facturación: casos límite (e2e)', () => {
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

  async function signedContract(
    auth: Record<string, string>,
    customerId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const create = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, priceMonthly: 30, depositAmount: 0, ...body });
    expect(create.status).toBe(201);
    await http().post(`/contracts/${create.body.id}/sign`).set(auth).expect(200);
    return create.body.id as string;
  }

  const rentOf = async (contractId: string, from: string) => {
    const inv = await admin.invoice.findFirst({
      where: { contractId, periodStart: new Date(from), kind: 'invoice' },
      include: { items: true },
    });
    return inv;
  };

  it('recurrente: prorratea alta y baja a mitad de mes y no factura tras la baja', async () => {
    const owner = await registerVerifiedUser(app, 'edgesrec');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Alta el 16 de junio (30 días): 15 días → 15 € de 30.
    const lateStart = await signedContract(auth, customerId, unitIds[0]!, {
      startDate: '2026-06-16',
    });
    // Baja el 10 de junio: 10 días → 10 €; julio no se factura.
    const ending = await signedContract(auth, customerId, unitIds[1]!, {
      startDate: '2026-01-01',
    });
    await admin.contract.update({
      where: { id: ending },
      data: { endDate: new Date('2026-06-10'), status: 'ending' },
    });

    const billing = app.get(BillingJobsService);
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });
    const late = await rentOf(lateStart, '2026-06-16');
    expect(Number(late!.items[0]!.unitPrice)).toBe(15);
    expect(late!.periodEnd!.toISOString().slice(0, 10)).toBe('2026-06-30');
    const end = await rentOf(ending, '2026-06-01');
    expect(Number(end!.items[0]!.unitPrice)).toBe(10);
    expect(end!.periodEnd!.toISOString().slice(0, 10)).toBe('2026-06-10');

    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    });
    expect(
      await admin.invoice.count({
        where: { contractId: ending, periodStart: { gte: new Date('2026-07-01') } },
      }),
    ).toBe(0);
  });

  it('recurrente: un prepago se renueva aunque el contrato tenga una factura sin periodo', async () => {
    const owner = await registerVerifiedUser(app, 'edgesprepay');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signedContract(auth, customerId, unitIds[0]!, {
      startDate: '2026-01-01',
      billingIntervalMonths: 6,
    });
    const billing = app.get(BillingJobsService);
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    });
    // Factura suelta del contrato, sin periodo (p. ej. un ajuste).
    const loose = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      });
    expect(loose.status).toBe(201);
    const run = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    });
    expect(run.created).toBe(1);
    const next = await rentOf(contractId, '2026-07-01');
    expect(next!.periodEnd!.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('revertir una devolución solo marca fallido el cobro devuelto', async () => {
    const owner = await registerVerifiedUser(app, 'edgesrevert');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 60, methodType: 'cash' })
      .expect(200);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 61, methodType: 'cash' })
      .expect(200);

    await app.get(InvoicesService).revertPayment({
      tenantId: owner.tenantId,
      userId: null,
      invoiceId: id,
      amount: 60,
      reason: 'Devolución',
      meta: {},
    });
    const pays = await admin.payment.findMany({
      where: { invoiceId: id },
      orderBy: { amount: 'asc' },
    });
    expect(pays.map((p) => [Number(p.amount), p.status])).toEqual([
      [60, 'failed'],
      [61, 'succeeded'],
    ]);
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(Number(inv.amountPaid)).toBe(61);
  });

  async function goCardlessCharge(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const webhookSecret = `whsec_${suffix}_123456`;
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${suffix}@e2e.local`,
    });
    await http()
      .put('/settings/gocardless')
      .set(auth)
      .send({
        accessToken: `sandbox_token_${suffix}_123456`,
        webhookSecret,
        environment: 'sandbox',
        enabled: true,
      });
    const start = await http()
      .post('/settings/gocardless/mandate/start')
      .set(auth)
      .send({ customerId });
    await http()
      .post('/settings/gocardless/mandate/complete')
      .set(auth)
      .send({ customerId, billingRequestId: start.body.billingRequestId });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const charge = await http().post(`/payments/invoices/${invoiceId}/charge`).set(auth).send({});
    expect(charge.body.status).toBe('processing');
    const send = async (id: string, action: string) => {
      const body = JSON.stringify({
        events: [
          {
            id: `${id}-${RUN}`,
            resource_type: 'payments',
            action,
            links: { payment: charge.body.gatewayPaymentId },
          },
        ],
      });
      await http()
        .post(`/webhooks/gocardless/${owner.tenantId}`)
        .set('Content-Type', 'application/json')
        .set('Webhook-Signature', createHmac('sha256', webhookSecret).update(body).digest('hex'))
        .send(body)
        .expect(200);
    };
    return { owner, auth, invoiceId, send };
  }

  it('GoCardless: un fallo tardío tras confirmarse revierte el cobro', async () => {
    const { invoiceId, send } = await goCardlessCharge('edgeslate');
    await send('EV-ok', 'confirmed');
    expect((await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'paid',
    );
    await send('EV-late', 'late_failure_settled');
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).not.toBe('paid');
    expect(Number(inv.amountPaid)).toBe(0);
  });

  it('cobro por pasarela sobre una factura ya pagada → aviso de cobro duplicado', async () => {
    const { auth, invoiceId, send } = await goCardlessCharge('edgesdup');
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 60.5, methodType: 'cash', overridePaymentInFlight: true })
      .expect(200);
    await send('EV-dup', 'confirmed');
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const notifs = await http().get('/notifications').set(auth);
      found = (notifs.body.items as { type: string }[]).some((n) => n.type === 'payment.overpaid');
      if (!found) await new Promise((r) => setTimeout(r, 200));
    }
    expect(found).toBe(true);
  });

  it('facturas de suscripción emitidas a la vez: números distintos y sin duplicar el pago', async () => {
    const owner = await registerVerifiedUser(app, 'edgessaas');
    const previous = await admin.platformBillingSettings.findFirst();
    const settings =
      previous ??
      (await admin.platformBillingSettings.create({
        data: { legalName: 'TrasterOS SL', taxId: 'B12345674' },
      }));
    await admin.platformBillingSettings.update({
      where: { id: settings.id },
      data: {
        enabled: true,
        legalName: settings.legalName || 'TrasterOS SL',
        taxId: settings.taxId || 'B12345674',
      },
    });
    try {
      const pay = () =>
        admin.tenantSubscriptionPayment.create({
          data: {
            tenantId: owner.tenantId,
            provider: 'bank_transfer',
            amount: 49,
            paidAt: new Date(),
          },
        });
      const [a, b] = await Promise.all([pay(), pay()]);
      const svc = app.get(PlatformInvoicesService);
      const [ia, ib, ia2] = await Promise.all([
        svc.issueForPayment(a.id),
        svc.issueForPayment(b.id),
        svc.issueForPayment(a.id),
      ]);
      expect(ia.fullNumber).not.toBe(ib.fullNumber);
      expect(ia2.id).toBe(ia.id);
    } finally {
      await admin.platformBillingSettings.update({
        where: { id: settings.id },
        data: { enabled: previous?.enabled ?? false },
      });
    }
  });
});
