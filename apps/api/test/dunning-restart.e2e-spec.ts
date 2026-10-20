import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PaymentsService } from '../src/modules/payments/payments.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const DAY = 86_400_000;

describe('Escalado de impagos desde cero tras un cobro devuelto (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  /** El reinicio va por un evento asíncrono: espera a que aparezcan las acciones nuevas. */
  async function waitForNewCycle(invoiceId: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await admin.dunningAction.findMany({
        where: { invoiceId, supersededAt: null },
        orderBy: { scheduledFor: 'asc' },
      });
      if (rows.length > 0 && rows.every((r) => r.status === 'scheduled')) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  }

  /** Factura vencida hace 40 días, pagada, con su escalado ya ejecutado. */
  async function paidOverdueInvoice(owner: { accessToken: string; tenantId: string }) {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Rosa',
      lastName: 'Devuelta',
    });
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set(auth)
      .expect(200);
    const dueDate = new Date(Date.now() - 40 * DAY);
    await admin.invoice.update({ where: { id }, data: { dueDate, status: 'overdue' } });
    await admin.dunningAction.createMany({
      data: (
        ['email_reminder', 'email_reminder_final', 'access_block', 'legal_notice'] as const
      ).map((actionType) => ({
        tenantId: owner.tenantId,
        invoiceId: id,
        actionType,
        status: 'executed' as const,
        scheduledFor: dueDate,
        executedAt: dueDate,
      })),
    });
    return { id, customerId, number: issued.body.invoiceNumber as string, auth };
  }

  it('un contracargo vuelve a programar el calendario completo contando desde hoy', async () => {
    const owner = await registerVerifiedUser(app, 'dunrestart');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
    const inv = await paidOverdueInvoice(owner);
    const pi = `pi_restart_${owner.tenantId.slice(0, 8)}`;
    await admin.$transaction([
      admin.payment.create({
        data: {
          tenantId: owner.tenantId,
          invoiceId: inv.id,
          customerId: inv.customerId,
          amount: 121,
          status: 'succeeded',
          methodType: 'card',
          gateway: 'stripe',
          gatewayPaymentId: pi,
          paidAt: new Date(),
        },
      }),
      admin.invoice.update({
        where: { id: inv.id },
        data: { amountPaid: 121, status: 'paid', paidAt: new Date() },
      }),
    ]);

    const before = Date.now();
    await app.get(PaymentsService).syncDisputeFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: pi,
      reason: 'fraudulent',
    });

    const invoice = await admin.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(invoice.status).toBe('overdue');

    const fresh = await waitForNewCycle(inv.id);
    expect(fresh.map((a) => a.actionType)).toEqual([
      'email_reminder',
      'email_reminder_final',
      'access_block',
      'legal_notice',
    ]);
    expect(fresh.map((a) => a.status)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
    // Cuenta desde hoy, no desde el vencimiento original.
    const reminder = fresh[0]!.scheduledFor.getTime();
    expect(reminder).toBeGreaterThanOrEqual(before + DAY - 5_000);
    expect(reminder).toBeLessThan(before + DAY + 60_000);
    const block = fresh.find((a) => a.actionType === 'access_block')!;
    expect(block.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 14 * DAY - 5_000);

    // El ciclo anterior se conserva como historial.
    const old = await admin.dunningAction.findMany({
      where: { invoiceId: inv.id, supersededAt: { not: null } },
    });
    expect(old).toHaveLength(4);
    expect(old.every((a) => a.status === 'executed')).toBe(true);

    // Un segundo aviso del mismo contracargo no vuelve a reiniciar nada.
    await app.get(PaymentsService).syncDisputeFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: pi,
      reason: 'fraudulent',
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await admin.dunningAction.findMany({ where: { invoiceId: inv.id } });
    expect(after).toHaveLength(8);
  });

  it('una devolución del banco (N43) también reinicia el escalado, sin repetir el recargo ya emitido', async () => {
    const owner = await registerVerifiedUser(app, 'dunrestartn');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { lateFeeEnabled: true, lateFeeGraceDays: 7 },
    });
    const inv = await paidOverdueInvoice(owner);
    // Recargo de esta factura ya emitido en el ciclo anterior.
    await request(app.getHttpServer())
      .post(`/invoices/${inv.id}/late-fee`)
      .set(inv.auth)
      .then((r) => expect([200, 201]).toContain(r.status));

    // Cobro por N43 y, después, su devolución.
    const imp1 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(inv.auth)
      .send({ filename: 'cobro.n43', content: buildN43('00000000012100', inv.number) });
    const st1 = await request(app.getHttpServer())
      .get(`/bank-statements/${imp1.body.statements[0].id}`)
      .set(inv.auth);
    const credit = st1.body.transactions.find((t: { type: string }) => t.type === 'credit');
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(inv.auth)
      .send({ invoiceId: inv.id })
      .expect(200);
    const imp2 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(inv.auth)
      .send({
        filename: 'devolucion.n43',
        content: buildN43('00000000000100', `OTRA-${inv.number}`, '00000000012100'),
      });
    const st2 = await request(app.getHttpServer())
      .get(`/bank-statements/${imp2.body.statements[0].id}`)
      .set(inv.auth);
    const debit = st2.body.transactions.find((t: { type: string }) => t.type === 'debit');
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(inv.auth)
      .send({ invoiceId: inv.id })
      .expect(200);

    const fresh = await waitForNewCycle(inv.id);
    const types = fresh.map((a) => a.actionType);
    expect(types).toContain('email_reminder');
    expect(types).toContain('access_block');
    expect(types).not.toContain('late_fee');
  });

  it('si la factura aún no ha vencido, no se reinicia nada (lo hará el cron a su fecha)', async () => {
    const owner = await registerVerifiedUser(app, 'dunrestartf');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Sin',
      lastName: 'Vencer',
    });
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    await admin.invoice.update({
      where: { id },
      data: { dueDate: new Date(Date.now() + 10 * DAY) },
    });
    const pi = `pi_future_${owner.tenantId.slice(0, 8)}`;
    await admin.$transaction([
      admin.payment.create({
        data: {
          tenantId: owner.tenantId,
          invoiceId: id,
          customerId,
          amount: 121,
          status: 'succeeded',
          methodType: 'card',
          gateway: 'stripe',
          gatewayPaymentId: pi,
          paidAt: new Date(),
        },
      }),
      admin.invoice.update({
        where: { id },
        data: { amountPaid: 121, status: 'paid', paidAt: new Date() },
      }),
    ]);
    await app.get(PaymentsService).syncDisputeFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: pi,
    });
    await new Promise((r) => setTimeout(r, 400));
    const invoice = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe('issued');
    expect(await admin.dunningAction.count({ where: { invoiceId: id } })).toBe(0);
  });
});
