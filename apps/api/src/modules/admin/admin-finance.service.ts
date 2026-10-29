import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { currentMonth } from '../../common/format';
import { financeSource, netPaid, OWN_KEY_AI_FEATURES } from '../../common/saas-metrics';
import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type {
  AdminFinanceAiDto,
  AdminFinanceMonthDto,
  AdminFinanceOverviewDto,
  AdminFinanceSource,
} from '@storageos/shared';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Dashboard financiero del SaaS (cross-tenant): ingresos reales cobrados por
 * forma de cobro (Stripe, remesas SEPA, Redsys y lo apuntado a mano), netos de
 * reembolsos y contracargos perdidos,
 * serie mensual y reconciliación con lo facturado. Todo de
 * `tenant_subscription_payments` (status `paid`) + `platform_invoices`.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly addons: SaasAddonsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Lo que pagan por la IA y lo que cuesta este mes. */
  private async aiOverview(): Promise<AdminFinanceAiDto> {
    const month = currentMonth();
    const [addons, tokens, queries, own] = await Promise.all([
      this.admin.tenantSubscriptionAddon.findMany({
        where: {
          suspendedAt: null,
          tenant: { deletedAt: null },
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
    ]);
    const input = tokens._sum.inputTokens ?? 0;
    const output = tokens._sum.outputTokens ?? 0;
    const cost =
      (input * this.config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true }) +
        output * this.config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true })) /
      1_000_000;
    return {
      revenueMonthly: round2(addons.reduce((n, a) => n + Number(a.priceMonthly) * a.quantity, 0)),
      costUsdThisMonth: round2(cost),
      queriesThisMonth: queries,
      ownKeyQueriesThisMonth: own,
    };
  }

  async getOverview(monthsArg = 12): Promise<AdminFinanceOverviewDto> {
    const months = Math.min(Math.max(monthsArg, 1), 24);
    const now = new Date();
    // Primer día (UTC) del mes N-1 hacia atrás.
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

    const fromPrev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1));
    const [payments, invoiceAgg, addonsMrr, prevPayments, prevInvoices, ai] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: ['paid', 'partially_refunded', 'refunded'] },
          paidAt: { gte: from },
        },
        select: {
          paidAt: true,
          amount: true,
          refundedAmount: true,
          disputedAt: true,
          provider: true,
        },
      }),
      // Facturado neto: una factura sustituida (`rectified`) ya cuenta en su
      // sustitutiva; los abonos (importes negativos) restan solos.
      this.admin.platformInvoice.aggregate({
        where: { issuedAt: { gte: from }, status: { not: 'rectified' } },
        _sum: { total: true },
      }),
      // Mismo criterio que admin-metrics: solo tenants que pagan.
      this.addons.addonsMrrForActiveTenants(),
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: ['paid', 'partially_refunded', 'refunded'] },
          paidAt: { gte: fromPrev, lt: from },
        },
        select: { amount: true, refundedAmount: true },
      }),
      this.admin.platformInvoice.aggregate({
        where: { issuedAt: { gte: fromPrev, lt: from }, status: { not: 'rectified' } },
        _sum: { total: true },
      }),
      this.aiOverview(),
    ]);

    // Lista de meses del periodo (para que la serie no tenga huecos).
    const monthList: string[] = [];
    for (let i = 0; i < months; i++) {
      monthList.push(
        monthKey(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1))),
      );
    }
    const emptySources = (): Record<AdminFinanceSource, number> => ({
      stripe: 0,
      sepa: 0,
      redsys: 0,
      manual: 0,
    });
    const monthMap = new Map(monthList.map((m) => [m, emptySources()]));

    const byProviderMap = new Map<string, { total: number; count: number }>();
    const bySource = emptySources();
    let refundedTotal = 0;
    let disputedTotal = 0;
    for (const p of payments) {
      if (!p.paidAt) continue;
      const amount = netPaid(p);
      refundedTotal += Number(p.refundedAmount);
      if (p.disputedAt) disputedTotal += amount;
      const source = financeSource(p.provider);
      bySource[source] += amount;
      const bucket = monthMap.get(monthKey(p.paidAt));
      if (bucket) bucket[source] += amount;
      const slice = byProviderMap.get(p.provider) ?? { total: 0, count: 0 };
      slice.total += amount;
      slice.count += 1;
      byProviderMap.set(p.provider, slice);
    }

    const monthly: AdminFinanceMonthDto[] = monthList.map((m) => {
      const b = monthMap.get(m) ?? emptySources();
      return {
        month: m,
        stripe: round2(b.stripe),
        sepa: round2(b.sepa),
        redsys: round2(b.redsys),
        manual: round2(b.manual),
        total: round2(b.stripe + b.sepa + b.redsys + b.manual),
      };
    });
    const collected = bySource.stripe + bySource.sepa + bySource.redsys + bySource.manual;

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
      addonsMrr,
      invoicedTotal: round2(Number(invoiceAgg._sum.total ?? 0)),
      byProvider: [...byProviderMap.entries()]
        .map(([provider, v]) => ({ provider, total: round2(v.total), count: v.count }))
        .sort((a, b) => b.total - a.total),
      monthly,
      previous: {
        collectedTotal: round2(prevPayments.reduce((sum, p) => sum + netPaid(p), 0)),
        refundedTotal: round2(prevPayments.reduce((sum, p) => sum + Number(p.refundedAmount), 0)),
        invoicedTotal: round2(Number(prevInvoices._sum.total ?? 0)),
      },
      ai,
    };
  }
}
