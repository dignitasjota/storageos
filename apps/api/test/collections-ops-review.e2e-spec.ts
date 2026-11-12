import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import {
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;
const REDSYS_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const iso = (d: Date) => d.toISOString().slice(0, 10);
/**
 * Hoy menos `days` días de calendario en la hora de España (la del negocio):
 * así cuenta los días el servicio. Restar horas fallaba de noche cuando el
 * intervalo cruza un cambio de hora.
 */
const madridDay = (days: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * Revisión de Cobros del mes, Deudores y planes de pago: lo cobrado es el de
 * las facturas y neto de devoluciones; los fallidos son intentos de cobro;
 * Deudores marca lo que ya se está cobrando, cuenta la antigüedad por factura
 * y el último aviso real; los planes respetan el alcance por local, admiten
 * cuotas por transferencia, se cancelan al anular una factura y el inquilino
 * paga la cuota desde su área de clientes.
 */
describe('Cobros del mes, Deudores y planes: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  /** Factura emitida y vencida hace `daysAgo` días. */
  async function overdue(customerId: string, unitPrice: number, daysAgo: number) {
    const id = await issued(customerId, unitPrice);
    await admin.invoice.update({
      where: { id },
      data: {
        status: 'overdue',
        dueDate: new Date(`${madridDay(daysAgo)}T00:00:00Z`),
      },
    });
    return id;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'opsrev');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('cobros del mes: solo facturas, neto de devoluciones; fallidos de la pasarela; febrero en 4 semanas', async () => {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' })
      .format(new Date())
      .slice(0, 7);
    const before = (await http().get(`/collections-month?month=${month}`).set(auth()).expect(200))
      .body as { collected: { amount: number }; failed: { count: number } };
    const customerId = await createCustomer(app, owner.accessToken);

    const paid = await issued(customerId);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await http()
      .post(`/invoices/${paid}/refund`)
      .set(auth())
      .send({ amount: 21, reason: 'Ajuste', refundMethod: 'cash' })
      .expect(200);
    // Una fianza no es un cobro de factura.
    const receipt = await issued(customerId, 50);
    await admin.invoice.update({ where: { id: receipt }, data: { kind: 'deposit_receipt' } });
    await http()
      .post(`/invoices/${receipt}/mark-paid`)
      .set(auth())
      .send({ amount: 60.5, methodType: 'cash' })
      .expect(200);
    // Un cobro a mano deshecho no es un intento de cobro fallido.
    const undone = await issued(customerId, 10);
    await http()
      .post(`/invoices/${undone}/mark-paid`)
      .set(auth())
      .send({ amount: 12.1, methodType: 'bank_transfer' })
      .expect(200);
    const pay = await admin.payment.findFirstOrThrow({ where: { invoiceId: undone } });
    await http()
      .post(`/invoices/${undone}/payments/${pay.id}/undo`)
      .set(auth())
      .send({ reason: 'Era de otro inquilino' })
      .expect(200);
    // Un cobro con tarjeta rechazado, cobrado después en efectivo.
    const retried = await issued(customerId, 20);
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: retried,
        customerId,
        amount: 24.2,
        status: 'failed',
        methodType: 'card',
        gateway: 'stripe',
        failureReason: 'card_declined',
      },
    });
    await http()
      .post(`/invoices/${retried}/mark-paid`)
      .set(auth())
      .send({ amount: 24.2, methodType: 'cash' })
      .expect(200);

    const res = (await http().get(`/collections-month?month=${month}`).set(auth()).expect(200))
      .body as {
      collected: { amount: number };
      failed: { count: number; items: { invoiceId: string; invoiceStatus: string | null }[] };
    };
    // 121 − 21 devuelto + 12,10 deshecho no cuenta + 24,20 = 124,20 más.
    expect(Math.round((res.collected.amount - before.collected.amount) * 100)).toBe(12420);
    expect(res.failed.count).toBe(before.failed.count + 1);
    expect(res.failed.items.find((i) => i.invoiceId === retried)?.invoiceStatus).toBe('paid');
    expect(res.failed.items.some((i) => i.invoiceId === undone)).toBe(false);

    const feb = (await http().get('/collections-month?month=2027-02').set(auth()).expect(200))
      .body as { weeks: { label: string }[] };
    expect(feb.weeks.map((w) => w.label)).toEqual(['1–7', '8–14', '15–21', '22–28']);
  });

  it('deudores: cobro en curso, antigüedad por factura, último aviso y paso aplazado', async () => {
    const charging = await createCustomer(app, owner.accessToken);
    const old = await overdue(charging, 100, 95);
    const recent = await overdue(charging, 400, 5);
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: recent,
        customerId: charging,
        amount: 484,
        status: 'processing',
        methodType: 'sepa_debit',
        gateway: 'gocardless',
      },
    });
    const reminded = await createCustomer(app, owner.accessToken);
    const late = await overdue(reminded, 50, 10);
    await admin.dunningAction.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: late,
        actionType: 'late_fee',
        scheduledFor: new Date(Date.now() - 2 * DAY),
      },
    });
    const sent = await http()
      .post('/invoices/bulk/remind')
      .set(auth())
      .send({ ids: [late] })
      .expect(200);
    expect(sent.body.succeeded).toEqual([late]);

    const res = (await http().get('/arrears').set(auth()).expect(200)).body as {
      customers: number;
      actionable: number;
      aging: { label: string; amount: number; count: number }[];
      rows: {
        customerId: string;
        paymentInFlight: string | null;
        lastReminderAt: string | null;
        nextStep: { postponed: boolean } | null;
        days: number;
      }[];
    };
    const rowCharging = res.rows.find((r) => r.customerId === charging)!;
    const rowReminded = res.rows.find((r) => r.customerId === reminded)!;
    expect(rowCharging.paymentInFlight).toBe('charge');
    expect(rowCharging.days).toBe(95);
    expect(res.actionable).toBe(res.customers - 1);
    expect(rowReminded.lastReminderAt).toBeTruthy();
    expect(rowReminded.nextStep?.postponed).toBe(true);
    // Por factura: los 100 de hace 95 días a +90 y los 400 de hace 5 a 0-30.
    expect(res.aging[3]).toMatchObject({ amount: 121, count: 1 });
    expect(res.aging[0]!.amount).toBeGreaterThanOrEqual(484);
    expect(old).toBeTruthy();
    await http().get('/arrears?facilityId=no-es-un-id').set(auth()).expect(400);
  });

  it('planes: alcance por local, cuota por transferencia y cancelado al anular una factura', async () => {
    // Inquilino con contrato en otro local: quien solo ve el suyo no ve su plan.
    const outsider = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: outsider });
    await overdue(outsider, 100, 20);
    const outsiderPlan = await http()
      .post('/payment-plans')
      .set(auth())
      .send({
        customerId: outsider,
        installmentsCount: 2,
        firstDueDate: iso(new Date(Date.now() + 3 * DAY)),
        notifyCustomer: false,
      })
      .expect(201);
    const mine = await http()
      .post('/facilities')
      .set(auth())
      .send({ name: 'Local propio', city: 'Madrid', postalCode: '28001' })
      .expect(201);
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [mine.body.id as string],
      tag: 'planscope',
    });
    const listed = (await http().get('/payment-plans').set(scoped).expect(200)).body as {
      id: string;
    }[];
    expect(listed.some((p) => p.id === outsiderPlan.body.id)).toBe(false);
    await http()
      .post(`/payment-plans/${outsiderPlan.body.id as string}/cancel`)
      .set(scoped)
      .expect(404);

    // Fechas comprobadas.
    const customerId = await createCustomer(app, owner.accessToken);
    const invoice = await overdue(customerId, 100, 10);
    await http()
      .post('/payment-plans')
      .set(auth())
      .send({ customerId, installmentsCount: 2, firstDueDate: '2026-02-31' })
      .expect(400);
    await http()
      .post('/payment-plans')
      .set(auth())
      .send({
        customerId,
        installmentsCount: 2,
        firstDueDate: iso(new Date(Date.now() + 3 * DAY)),
        notifyCustomer: false,
      })
      .expect(201);
    // Una cuota por transferencia (antes solo se admitía en efectivo).
    await http()
      .post(`/invoices/${invoice}/mark-paid`)
      .set(auth())
      .send({ amount: 60.5, methodType: 'bank_transfer' })
      .expect(200);

    // Anular una factura del plan lo cancela.
    const other = await createCustomer(app, owner.accessToken);
    const voided = await overdue(other, 30, 10);
    const plan = await http()
      .post('/payment-plans')
      .set(auth())
      .send({
        customerId: other,
        installmentsCount: 2,
        firstDueDate: iso(new Date(Date.now() + 3 * DAY)),
        notifyCustomer: false,
      })
      .expect(201);
    await http()
      .post(`/invoices/${voided}/cancel`)
      .set(auth())
      .send({ reason: 'Emitida por error' })
      .expect(200);
    let status = '';
    for (let i = 0; i < 40 && status !== 'cancelled'; i += 1) {
      status = (await admin.paymentPlan.findUniqueOrThrow({ where: { id: plan.body.id } })).status;
      if (status !== 'cancelled') await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe('cancelled');
  });

  it('el inquilino paga la cuota de su plan desde su área de clientes', async () => {
    await http()
      .put('/settings/redsys')
      .set(auth())
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: REDSYS_KEY,
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    const invoice = await overdue(customerId, 100, 10);
    const lonely = await issued(customerId, 10);
    await http()
      .post('/payment-plans')
      .set(auth())
      .send({
        customerId,
        invoiceIds: [invoice],
        installmentsCount: 2,
        firstDueDate: iso(new Date(Date.now() + 3 * DAY)),
        notifyCustomer: false,
      })
      .expect(201);

    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth()).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token')!;
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    const portal = { Authorization: `Bearer ${consume.body.accessToken as string}` };

    const list = (await http().get('/portal/me/invoices').set(portal).expect(200)).body as {
      id: string;
      planInstallment: { amount: number } | null;
    }[];
    expect(list.find((i) => i.id === invoice)?.planInstallment?.amount).toBe(60.5);
    expect(list.find((i) => i.id === lonely)?.planInstallment).toBeNull();
    const none = await http()
      .post(`/portal/me/invoices/${lonely}/charge`)
      .set(portal)
      .send({ installment: true })
      .expect(400);
    expect(none.body.code).toBe('no_installment_due');

    const redirect = await http()
      .post(`/portal/me/invoices/${invoice}/redsys-redirect`)
      .set(portal)
      .send({ installment: true })
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters as string, 'base64').toString('utf8'),
    ) as { DS_MERCHANT_ORDER: string; DS_MERCHANT_AMOUNT: string };
    expect(params.DS_MERCHANT_AMOUNT).toBe('6050');
    const notif = encodeMerchantParameters({
      Ds_Order: params.DS_MERCHANT_ORDER,
      Ds_Response: '0000',
      Ds_Amount: '6050',
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: notif,
        Ds_Signature: signRequest(notif, params.DS_MERCHANT_ORDER, REDSYS_KEY),
      })
      .expect(200);
    const after = await admin.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(Number(after.amountPaid)).toBe(60.5);
    const plans = (
      await http().get(`/payment-plans?customerId=${customerId}`).set(auth()).expect(200)
    ).body as { paidSoFar: number; installments: { status: string }[] }[];
    expect(plans[0]!.paidSoFar).toBe(60.5);
    expect(plans[0]!.installments[0]!.status).toBe('paid');
  });
});
