import { NotFoundException } from '@nestjs/common';

import { BillingSaasService } from '../billing-saas.service';

import type { AuditService } from '../../auth/audit.service';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { PrismaService } from '../../database/prisma.service';
import type { StripeGateway } from '../../payments/stripe.gateway';
import type { PlatformCouponsService } from '../platform-coupons.service';
import type { PlatformInvoicesService } from '../platform-invoices.service';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const DAY = 24 * 60 * 60 * 1000;

interface AdminMock {
  tenantSubscription: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  tenantSubscriptionPayment: {
    create: jest.Mock;
    update: jest.Mock;
    findFirst: jest.Mock;
  };
  tenant: {
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay-1',
    provider: 'bank_transfer',
    status: 'paid',
    amount: 58,
    discount: null,
    currency: 'EUR',
    planSlug: 'starter',
    planName: 'Starter',
    description: null,
    periodStart: new Date('2026-08-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    paidAt: new Date('2026-07-02T00:00:00Z'),
    invoiceUrl: null,
    pdfUrl: null,
    createdAt: new Date('2026-07-02T00:00:00Z'),
    ...overrides,
  };
}

function buildAdmin(): AdminMock {
  return {
    tenantSubscription: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'sub-1' }),
    },
    tenantSubscriptionPayment: {
      create: jest.fn().mockResolvedValue(paymentRow()),
      update: jest.fn().mockResolvedValue(paymentRow()),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // El array-form de $transaction recibe las promesas ya lanzadas.
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function buildService(admin: AdminMock): {
  service: BillingSaasService;
  audit: jest.Mock;
  issueBestEffort: jest.Mock;
} {
  const audit = jest.fn().mockResolvedValue(undefined);
  const issueBestEffort = jest.fn().mockResolvedValue(undefined);
  const service = new BillingSaasService(
    {} as unknown as PrismaService,
    admin as unknown as PrismaAdminService,
    { write: audit } as unknown as AuditService,
    { issueForPaymentBestEffort: issueBestEffort } as unknown as PlatformInvoicesService,
    {
      validateAndComputeDiscount: jest.fn(),
      incrementUsage: jest.fn(),
    } as unknown as PlatformCouponsService,
    { getClient: () => ({}) } as unknown as StripeGateway,
  );
  return { service, audit, issueBestEffort };
}

describe('BillingSaasService', () => {
  afterEach(() => jest.useRealTimers());

  // ============================== recordManualPayment =====================

  it('recordManualPayment extiende desde el fin de periodo futuro y acumula los días (con Stripe)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T10:00:00Z'));
    const admin = buildAdmin();
    const periodEnd = new Date('2026-08-01T00:00:00Z');
    admin.tenantSubscription.findUnique.mockResolvedValue({
      currentPeriodEnd: periodEnd,
      // Tiene Stripe → el crédito manual SÍ se acumula (el webhook lo sumará).
      stripeSubscriptionId: 'sub_x',
      plan: { slug: 'starter', name: 'Starter' },
    });
    const { service, issueBestEffort } = buildService(admin);

    const dto = await service.recordManualPayment({
      tenantId: TENANT,
      provider: 'bank_transfer',
      amount: 58,
      currency: 'EUR',
      durationMonths: 2,
    });

    // El pago cubre [fin actual, fin actual + 2 meses].
    const createData = admin.tenantSubscriptionPayment.create.mock.calls[0]![0].data;
    expect(createData.periodStart).toEqual(periodEnd);
    expect(createData.periodEnd).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(createData.status).toBe('paid');
    expect(createData.planSlug).toBe('starter');

    // La suscripción avanza y ACUMULA el crédito manual (61 días de ago+sep).
    const updateData = admin.tenantSubscription.update.mock.calls[0]![0].data;
    expect(updateData.currentPeriodEnd).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(updateData.status).toBe('active');
    expect(updateData.manualExtensionDays).toEqual({ increment: 61 });

    // Factura del SaaS best-effort + DTO mapeado.
    expect(issueBestEffort).toHaveBeenCalledWith('pay-1');
    expect(dto.amount).toBe(58);
    expect(dto.periodEnd).toBe('2026-10-01T00:00:00.000Z');
  });

  it('recordManualPayment SIN Stripe extiende el periodo pero NO acumula crédito', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T10:00:00Z'));
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue({
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
      stripeSubscriptionId: null, // sin Stripe → no hay webhook que pise el periodo
      plan: { slug: 'starter', name: 'Starter' },
    });
    const { service } = buildService(admin);

    await service.recordManualPayment({
      tenantId: TENANT,
      provider: 'cash',
      amount: 49,
      currency: 'EUR',
      durationMonths: 2,
    });

    const updateData = admin.tenantSubscription.update.mock.calls[0]![0].data;
    // El periodo se extiende (verdad absoluta), pero el acumulador NO crece
    // (si no, al vincularse a Stripe se le regalaría ese tiempo ya consumido).
    expect(updateData.currentPeriodEnd).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(updateData.manualExtensionDays).toEqual({ increment: 0 });
  });

  it('recordManualPayment con la suscripción vencida parte de AHORA, no del pasado', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T10:00:00Z'));
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue({
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'), // vencida hace un mes
      plan: { slug: 'starter', name: 'Starter' },
    });
    const { service } = buildService(admin);

    await service.recordManualPayment({
      tenantId: TENANT,
      provider: 'cash',
      amount: 29,
      currency: 'EUR',
      durationMonths: 1,
    });

    const createData = admin.tenantSubscriptionPayment.create.mock.calls[0]![0].data;
    // base = now (no regala el mes de junio ya vencido).
    expect(createData.periodStart).toEqual(new Date('2026-07-02T10:00:00Z'));
    expect(createData.periodEnd).toEqual(new Date('2026-08-02T10:00:00Z'));
  });

  it('recordManualPayment ajusta el desbordamiento de fin de mes (31 ene + 1 mes → 28 feb)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T00:00:00Z'));
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue({
      currentPeriodEnd: new Date('2026-01-31T12:00:00Z'),
      plan: { slug: 'pro', name: 'Pro' },
    });
    const { service } = buildService(admin);

    await service.recordManualPayment({
      tenantId: TENANT,
      provider: 'other',
      amount: 99,
      currency: 'EUR',
      durationMonths: 1,
    });

    const createData = admin.tenantSubscriptionPayment.create.mock.calls[0]![0].data;
    const end = createData.periodEnd as Date;
    // 2026 no es bisiesto → 28 de febrero, no 3 de marzo.
    expect(end.getMonth()).toBe(1);
    expect(end.getDate()).toBe(28);
  });

  it('recordManualPayment sin suscripción lanza 404', async () => {
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue(null);
    const { service } = buildService(admin);

    await expect(
      service.recordManualPayment({
        tenantId: TENANT,
        provider: 'cash',
        amount: 10,
        currency: 'EUR',
        durationMonths: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(admin.$transaction).not.toHaveBeenCalled();
  });

  // ============================ syncSubscriptionFromStripe ================

  const stripeSyncArgs = {
    stripeSubscriptionId: 'sub_123',
    stripeCustomerId: 'cus_123',
    tenantIdHint: TENANT,
    status: 'active',
    currentPeriodStart: Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
    currentPeriodEnd: Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000),
    cancelAtPeriodEnd: false,
  };

  it('syncSubscriptionFromStripe SUMA el crédito manual al periodo de Stripe', async () => {
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue({ manualExtensionDays: 30 });
    const { service, audit } = buildService(admin);

    await service.syncSubscriptionFromStripe(stripeSyncArgs);

    const data = admin.tenantSubscription.update.mock.calls[0]![0].data;
    // periodo efectivo = fecha de Stripe + 30 días de crédito manual.
    expect(data.currentPeriodEnd).toEqual(
      new Date(new Date('2026-08-01T00:00:00Z').getTime() + 30 * DAY),
    );
    expect(data.status).toBe('active');
    expect(audit).toHaveBeenCalled();
  });

  it('syncSubscriptionFromStripe sin crédito manual usa la fecha de Stripe tal cual y mapea el status', async () => {
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue({ manualExtensionDays: 0 });
    const { service } = buildService(admin);

    await service.syncSubscriptionFromStripe({ ...stripeSyncArgs, status: 'past_due' });

    const data = admin.tenantSubscription.update.mock.calls[0]![0].data;
    expect(data.currentPeriodEnd).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(data.status).toBe('past_due');
  });

  it('syncSubscriptionFromStripe con tenant no resoluble no toca la BD', async () => {
    const admin = buildAdmin();
    admin.tenantSubscription.findUnique.mockResolvedValue(null); // lookup por subId
    admin.tenantSubscription.findFirst.mockResolvedValue(null); // lookup por customer
    const { service, audit } = buildService(admin);

    await service.syncSubscriptionFromStripe({ ...stripeSyncArgs, tenantIdHint: null });

    expect(admin.tenantSubscription.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  // ========================== recordStripeInvoiceFromWebhook ==============

  type StripeInvoiceArg = Parameters<BillingSaasService['recordStripeInvoiceFromWebhook']>[0];

  function stripeInvoice(overrides: Record<string, unknown> = {}): StripeInvoiceArg {
    return {
      id: 'in_123',
      customer: 'cus_123',
      status: 'paid',
      amount_paid: 2999,
      amount_due: 2999,
      total: 2999,
      currency: 'eur',
      description: null,
      lines: { data: [] },
      period_start: Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
      period_end: Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000),
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      hosted_invoice_url: 'https://stripe.example/inv',
      invoice_pdf: null,
      ...overrides,
    } as unknown as StripeInvoiceArg;
  }

  function withResolvableTenant(admin: AdminMock): void {
    // resolveTenantId → por customer (findFirst); luego el include del plan.
    admin.tenantSubscription.findFirst.mockResolvedValue({ tenantId: TENANT });
    admin.tenantSubscription.findUnique.mockResolvedValue({
      plan: { slug: 'pro', name: 'Pro' },
    });
  }

  it('registra un pago de Stripe nuevo (céntimos→euros) y emite la factura del SaaS', async () => {
    const admin = buildAdmin();
    withResolvableTenant(admin);
    admin.tenantSubscriptionPayment.create.mockResolvedValue(paymentRow({ status: 'paid' }));
    const { service, issueBestEffort } = buildService(admin);

    await service.recordStripeInvoiceFromWebhook(stripeInvoice());

    const data = admin.tenantSubscriptionPayment.create.mock.calls[0]![0].data;
    expect(data.provider).toBe('stripe');
    expect(data.externalId).toBe('in_123');
    expect(data.amount).toBe(29.99);
    expect(data.currency).toBe('EUR');
    expect(data.planSlug).toBe('pro');
    expect(issueBestEffort).toHaveBeenCalledWith('pay-1');
  });

  it('es idempotente: si el external_id ya existe, actualiza en vez de crear (y no re-factura)', async () => {
    const admin = buildAdmin();
    withResolvableTenant(admin);
    admin.tenantSubscriptionPayment.findFirst.mockResolvedValue({ id: 'pay-existing' });
    const { service, issueBestEffort } = buildService(admin);

    await service.recordStripeInvoiceFromWebhook(stripeInvoice());

    expect(admin.tenantSubscriptionPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pay-existing' } }),
    );
    expect(admin.tenantSubscriptionPayment.create).not.toHaveBeenCalled();
    expect(issueBestEffort).not.toHaveBeenCalled();
  });

  it('con tenant no resoluble no registra nada', async () => {
    const admin = buildAdmin();
    admin.tenantSubscription.findFirst.mockResolvedValue(null);
    admin.tenantSubscription.findUnique.mockResolvedValue(null);
    const { service } = buildService(admin);

    await service.recordStripeInvoiceFromWebhook(stripeInvoice());

    expect(admin.tenantSubscriptionPayment.create).not.toHaveBeenCalled();
    expect(admin.tenantSubscriptionPayment.update).not.toHaveBeenCalled();
  });

  it('una race del create (índice único) se traga sin lanzar', async () => {
    const admin = buildAdmin();
    withResolvableTenant(admin);
    admin.tenantSubscriptionPayment.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const { service, issueBestEffort } = buildService(admin);

    await expect(service.recordStripeInvoiceFromWebhook(stripeInvoice())).resolves.toBeUndefined();
    expect(issueBestEffort).not.toHaveBeenCalled();
  });

  it('un pago no cobrado (status open) se registra sin emitir factura del SaaS', async () => {
    const admin = buildAdmin();
    withResolvableTenant(admin);
    admin.tenantSubscriptionPayment.create.mockResolvedValue(paymentRow({ status: 'open' }));
    const { service, issueBestEffort } = buildService(admin);

    await service.recordStripeInvoiceFromWebhook(stripeInvoice({ status: 'open' }));

    expect(admin.tenantSubscriptionPayment.create).toHaveBeenCalled();
    expect(issueBestEffort).not.toHaveBeenCalled();
  });
});
