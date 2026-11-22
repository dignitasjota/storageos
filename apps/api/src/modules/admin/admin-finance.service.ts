import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { currentMonth } from '../../common/format';
import {
  COLLECTED_PAYMENT_STATUSES,
  currentMrrByTenant,
  financeSource,
  listPriceWithoutVat,
  madridMonthIndex,
  monthIndexLabel,
  monthIndexStart,
  netPaid,
  OWN_KEY_AI_FEATURES,
} from '../../common/saas-metrics';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  AdminFinanceAiDto,
  AdminFinanceMonthDto,
  AdminFinanceOverviewDto,
  AdminFinanceReconciliationDto,
  AdminFinanceSource,
} from '@storageos/shared';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Devoluciones hechas en `[from, to)`: por su fecha (las antiguas sin fecha, por la del cobro). */
function refundedBetweenWhere(from: Date, to?: Date): Prisma.TenantSubscriptionPaymentWhereInput {
  const range = to ? { gte: from, lt: to } : { gte: from };
  return {
    refundedAmount: { gt: 0 },
    OR: [{ refundedAt: range }, { refundedAt: null, paidAt: range }],
  };
}

/**
 * Dashboard financiero del SaaS (cross-tenant): ingresos reales cobrados por
 * forma de cobro (Stripe, remesas SEPA, Redsys y lo apuntado a mano), netos de
 * reembolsos y contracargos perdidos, serie mensual, lo devuelto en cada mes y
 * los cobros sin factura y facturas sin cobro. Lo cobrado, devuelto y facturado
 * va CON IVA; el MRR de los extras y la IA, SIN IVA. Meses en hora de España.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Lo que pagan por la IA (solo los tenants que pagan, sin IVA) y lo que cuesta este mes. */
  private async aiOverview(payingIds: string[]): Promise<AdminFinanceAiDto> {
    const month = currentMonth();
    const [addons, tokens, queries, own, pricing] = await Promise.all([
      this.admin.tenantSubscriptionAddon.findMany({
        where: {
          suspendedAt: null,
          tenantId: { in: payingIds },
          OR: [{ addon: { feature: 'ai_assistant' } }, { addon: { grantsAiQueries: { gt: 0 } } }],
        },
        select: { priceMonthly: true, quantity: true },
      }),
      this.admin.aiUsageEvent.aggregate({
        where: {
          countsAsQuery: false,
          ownKey: false,
          feature: { notIn: OWN_KEY_AI_FEATURES },
          createdAt: { gte: month.start },
        },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.admin.aiUsageEvent.count({
        where: { countsAsQuery: true, ownKey: false, createdAt: { gte: month.start } },
      }),
      this.admin.aiUsageEvent.count({
        where: { countsAsQuery: true, ownKey: true, createdAt: { gte: month.start } },
      }),
      platformPricing(this.admin),
    ]);
    const input = tokens._sum.inputTokens ?? 0;
    const output = tokens._sum.outputTokens ?? 0;
    const cost =
      (input * this.config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true }) +
        output * this.config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true })) /
      1_000_000;
    const gross = addons.reduce((n, a) => n + Number(a.priceMonthly) * a.quantity, 0);
    return {
      revenueMonthly: round2(listPriceWithoutVat(gross, pricing)),
      costUsdThisMonth: round2(cost),
      queriesThisMonth: queries,
      ownKeyQueriesThisMonth: own,
    };
  }

  /**
   * Cobros pagados del periodo sin factura de suscripción y facturas del
   * periodo (sin las rectificativas ni las sustituidas) sin cobro asociado.
   */
  private async reconciliation(from: Date): Promise<AdminFinanceReconciliationDto> {
    const [payments, invoices] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: ['paid', 'partially_refunded'] },
          paidAt: { gte: from },
          invoice: null,
          tenant: { billingExempt: false },
        },
        select: { amount: true },
      }),
      this.admin.platformInvoice.findMany({
        where: {
          issuedAt: { gte: from },
          paymentId: null,
          invoiceType: 'F1',
          status: { notIn: ['rectified', 'cancelled'] },
        },
        select: { total: true },
      }),
    ]);
    return {
      paymentsWithoutInvoice: {
        count: payments.length,
        total: round2(payments.reduce((s, p) => s + Number(p.amount), 0)),
      },
      invoicesWithoutPayment: {
        count: invoices.length,
        total: round2(invoices.reduce((s, i) => s + Number(i.total), 0)),
      },
    };
  }

  async getOverview(monthsArg = 12): Promise<AdminFinanceOverviewDto> {
    const months = Math.min(Math.max(Math.trunc(monthsArg) || 12, 1), 24);
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (months - 1);
    const from = monthIndexStart(firstIdx);
    const fromPrev = monthIndexStart(firstIdx - months);

    const paying = await currentMrrByTenant(this.admin);
    const [
      payments,
      refunds,
      invoiceAgg,
      prevPayments,
      prevRefunds,
      prevInvoices,
      reconciliation,
      ai,
    ] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: { in: [...COLLECTED_PAYMENT_STATUSES] }, paidAt: { gte: from } },
        select: {
          paidAt: true,
          amount: true,
          refundedAmount: true,
          disputedAt: true,
          provider: true,
        },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: refundedBetweenWhere(from),
        select: { refundedAmount: true, refundedAt: true, paidAt: true },
      }),
      // Facturado neto: una factura sustituida (`rectified`) ya cuenta en su
      // sustitutiva; los abonos (importes negativos) restan solos.
      this.admin.platformInvoice.aggregate({
        where: { issuedAt: { gte: from }, status: { not: 'rectified' } },
        _sum: { total: true },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: [...COLLECTED_PAYMENT_STATUSES] },
          paidAt: { gte: fromPrev, lt: from },
        },
        select: { amount: true, refundedAmount: true },
      }),
      this.admin.tenantSubscriptionPayment.aggregate({
        where: refundedBetweenWhere(fromPrev, from),
        _sum: { refundedAmount: true },
      }),
      this.admin.platformInvoice.aggregate({
        where: { issuedAt: { gte: fromPrev, lt: from }, status: { not: 'rectified' } },
        _sum: { total: true },
      }),
      this.reconciliation(from),
      this.aiOverview([...paying.keys()]),
    ]);

    // Meses del periodo (para que la serie no tenga huecos).
    const emptySources = (): Record<AdminFinanceSource, number> => ({
      stripe: 0,
      sepa: 0,
      redsys: 0,
      manual: 0,
    });
    const monthMap = new Map<number, Record<AdminFinanceSource, number>>();
    const refundMap = new Map<number, number>();
    for (let i = 0; i < months; i++) {
      monthMap.set(firstIdx + i, emptySources());
      refundMap.set(firstIdx + i, 0);
    }

    const byProviderMap = new Map<string, { total: number; count: number }>();
    const bySource = emptySources();
    let disputedTotal = 0;
    for (const p of payments) {
      if (!p.paidAt) continue;
      const amount = netPaid(p);
      if (p.disputedAt) disputedTotal += amount;
      const source = financeSource(p.provider);
      bySource[source] += amount;
      const bucket = monthMap.get(madridMonthIndex(p.paidAt));
      if (bucket) bucket[source] += amount;
      const slice = byProviderMap.get(p.provider) ?? { total: 0, count: 0 };
      slice.total += amount;
      slice.count += 1;
      byProviderMap.set(p.provider, slice);
    }
    let refundedTotal = 0;
    for (const r of refunds) {
      const at = r.refundedAt ?? r.paidAt;
      if (!at) continue;
      refundedTotal += Number(r.refundedAmount);
      const idx = madridMonthIndex(at);
      if (refundMap.has(idx)) refundMap.set(idx, refundMap.get(idx)! + Number(r.refundedAmount));
    }

    const monthly: AdminFinanceMonthDto[] = [...monthMap.entries()].map(([idx, b]) => ({
      month: monthIndexLabel(idx),
      stripe: round2(b.stripe),
      sepa: round2(b.sepa),
      redsys: round2(b.redsys),
      manual: round2(b.manual),
      total: round2(b.stripe + b.sepa + b.redsys + b.manual),
      refunded: round2(refundMap.get(idx) ?? 0),
    }));
    const collected = bySource.stripe + bySource.sepa + bySource.redsys + bySource.manual;
    let addonsMrr = 0;
    for (const p of paying.values()) addonsMrr += p.addons;

    return {
      currency: 'EUR',
      collectedTotal: round2(collected),
      refundedTotal: round2(refundedTotal),
      disputedTotal: round2(disputedTotal),
      bySource: {
        stripe: round2(bySource.stripe),
        sepa: round2(bySource.sepa),
        redsys: round2(bySource.redsys),
        manual: round2(bySource.manual),
      },
      addonsMrr: round2(addonsMrr),
      invoicedTotal: round2(Number(invoiceAgg._sum.total ?? 0)),
      reconciliation,
      byProvider: [...byProviderMap.entries()]
        .map(([provider, v]) => ({ provider, total: round2(v.total), count: v.count }))
        .sort((a, b) => b.total - a.total),
      monthly,
      previous: {
        collectedTotal: round2(prevPayments.reduce((sum, p) => sum + netPaid(p), 0)),
        refundedTotal: round2(Number(prevRefunds._sum.refundedAmount ?? 0)),
        invoicedTotal: round2(Number(prevInvoices._sum.total ?? 0)),
      },
      ai,
    };
  }
}
