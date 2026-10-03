import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';
import { PlatformInvoicesService } from '../src/modules/billing-saas/platform-invoices.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Reembolsos y contracargos de los cobros de suscripción: el pago guarda lo
 * devuelto y su factura (del negocio propio) recibe el abono, sin duplicarlo.
 */
describe('Reembolsos y contracargos de las suscripciones (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let billing: BillingSaasService;
  let invoices: PlatformInvoicesService;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    billing = app.get(BillingSaasService);
    invoices = app.get(PlatformInvoicesService);
    const sa = await seedSuperAdmin('saasrev');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await admin.platformBillingSettings.updateMany({ data: { ownTenantId: null } });
    await admin.superAdminNotification.deleteMany({ where: { type: 'saas_payment.disputed' } });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('reembolso por diferencia, sin abono doble, y contracargo perdido', async () => {
    const own = await registerVerifiedUser(app, 'saasrevown');
    await ensureDefaultSeries(app, own.accessToken);
    await admin.tenant.update({ where: { id: own.tenantId }, data: { taxId: 'B12345674' } });
    await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({
        legalName: 'TrasterOS SL',
        taxId: 'B12345674',
        address: 'Calle Mayor 1',
        city: 'Madrid',
        postalCode: '28001',
        country: 'ES',
        taxRate: 21,
        seriesPrefix: 'SAAS',
        enabled: true,
        ownTenantSlug: own.slug,
      })
      .expect(200);
    const client = await registerVerifiedUser(app, 'saasrevcli');

    // Un cobro de Stripe de la suscripción, facturado por el negocio propio.
    const stripePay = async (externalId: string) => {
      const p = await admin.tenantSubscriptionPayment.create({
        data: {
          tenantId: client.tenantId,
          provider: 'stripe',
          externalId,
          status: 'paid',
          amount: 121,
          currency: 'EUR',
          paidAt: new Date(),
        },
      });
      const inv = await invoices.issueForPayment(p.id);
      return { paymentId: p.id, realId: inv.ownTenantInvoiceId! };
    };
    const credits = (realId: string) =>
      admin.platformInvoice.findMany({
        where: { invoice: { rectifiesInvoiceId: realId } },
        orderBy: { createdAt: 'asc' },
      });

    // Reembolso parcial de 60,50 €.
    const a = await stripePay(`in_rev_a_${Date.now()}`);
    await billing.syncSubscriptionRefund(a.paymentId, 60.5);
    const payA = await admin.tenantSubscriptionPayment.findUniqueOrThrow({
      where: { id: a.paymentId },
    });
    expect(payA).toMatchObject({ status: 'partially_refunded' });
    expect(Number(payA.refundedAmount)).toBe(60.5);
    const first = await waitFor(async () => {
      const c = await credits(a.realId);
      return c.length === 1 && c;
    });
    expect(Number(first[0]!.total)).toBe(-60.5);
    expect(first[0]!.tenantId).toBe(client.tenantId);

    // El mismo aviso otra vez no abona dos veces.
    await billing.syncSubscriptionRefund(a.paymentId, 60.5);
    await new Promise((r) => setTimeout(r, 800));
    expect(await credits(a.realId)).toHaveLength(1);

    // Reembolso del resto: un segundo abono por la diferencia.
    await billing.syncSubscriptionRefund(a.paymentId, 121);
    const both = await waitFor(async () => {
      const c = await credits(a.realId);
      return c.length === 2 && c;
    });
    expect(Number(both[1]!.total)).toBe(-60.5);
    expect(
      (await admin.tenantSubscriptionPayment.findUniqueOrThrow({ where: { id: a.paymentId } }))
        .status,
    ).toBe('refunded');

    // Contracargo: abierto → aviso; perdido → abono total + suscripción impagada.
    const b = await stripePay(`in_rev_b_${Date.now()}`);
    await billing.markSubscriptionDisputed(b.paymentId, 'fraudulent');
    const notif = await admin.superAdminNotification.findFirst({
      where: { type: 'saas_payment.disputed', link: `/admin/tenants/${client.tenantId}` },
    });
    expect(notif).not.toBeNull();
    await admin.tenantSubscription.update({
      where: { tenantId: client.tenantId },
      data: { status: 'active' },
    });
    await billing.closeSubscriptionDispute(b.paymentId, true, 121);
    const lost = await waitFor(async () => {
      const c = await credits(b.realId);
      return c.length === 1 && c;
    });
    expect(Number(lost[0]!.total)).toBe(-121);
    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: client.tenantId },
    });
    expect(sub.status).toBe('past_due');
  }, 60_000);
});
