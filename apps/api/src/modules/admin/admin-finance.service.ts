import { Injectable } from '@nestjs/common';

import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { AdminFinanceMonthDto, AdminFinanceOverviewDto } from '@storageos/shared';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Dashboard financiero del SaaS (cross-tenant): ingresos reales cobrados por
 * fuente (Stripe automático vs pagos manuales — cash/transferencia/PayPal/otros),
 * serie mensual y reconciliación con lo facturado. Todo de
 * `tenant_subscription_payments` (status `paid`) + `platform_invoices`.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly addons: SaasAddonsService,
  ) {}

  async getOverview(monthsArg = 12): Promise<AdminFinanceOverviewDto> {
    const months = Math.min(Math.max(monthsArg, 1), 24);
    const now = new Date();
    // Primer día (UTC) del mes N-1 hacia atrás.
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

    const [payments, invoiceAgg, addonsByTenant] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: 'paid', paidAt: { gte: from } },
        select: { paidAt: true, amount: true, provider: true },
      }),
      this.admin.platformInvoice.aggregate({
        where: { issuedAt: { gte: from } },
        _sum: { total: true },
      }),
      this.addons.addonsMonthlyByTenant(),
    ]);

    // Lista de meses del periodo (para que la serie no tenga huecos).
    const monthList: string[] = [];
    for (let i = 0; i < months; i++) {
      monthList.push(
        monthKey(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1))),
      );
    }
    const monthMap = new Map<string, { stripe: number; manual: number }>(
      monthList.map((m) => [m, { stripe: 0, manual: 0 }]),
    );

    const byProviderMap = new Map<string, { total: number; count: number }>();
    let stripeTotal = 0;
    let manualTotal = 0;
    for (const p of payments) {
      if (!p.paidAt) continue;
      const amount = Number(p.amount);
      const isStripe = p.provider === 'stripe';
      if (isStripe) stripeTotal += amount;
      else manualTotal += amount;

      const bucket = monthMap.get(monthKey(p.paidAt));
      if (bucket) {
        if (isStripe) bucket.stripe += amount;
        else bucket.manual += amount;
      }
      const slice = byProviderMap.get(p.provider) ?? { total: 0, count: 0 };
      slice.total += amount;
      slice.count += 1;
      byProviderMap.set(p.provider, slice);
    }

    const monthly: AdminFinanceMonthDto[] = monthList.map((m) => {
      const b = monthMap.get(m) ?? { stripe: 0, manual: 0 };
      return {
        month: m,
        stripe: round2(b.stripe),
        manual: round2(b.manual),
        total: round2(b.stripe + b.manual),
      };
    });

    const addonsMrr = round2([...addonsByTenant.values()].reduce((s, v) => s + v, 0));

    return {
      currency: 'EUR',
      collectedTotal: round2(stripeTotal + manualTotal),
      stripeTotal: round2(stripeTotal),
      manualTotal: round2(manualTotal),
      addonsMrr,
      invoicedTotal: round2(Number(invoiceAgg._sum.total ?? 0)),
      byProvider: [...byProviderMap.entries()]
        .map(([provider, v]) => ({ provider, total: round2(v.total), count: v.count }))
        .sort((a, b) => b.total - a.total),
      monthly,
    };
  }
}
