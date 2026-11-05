import { Injectable } from '@nestjs/common';

import { type FacilityScope, invoiceFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import { InsightsService } from '../analytics/insights.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { CustomerInsightsDto, CustomerRiskLevel } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Un vistazo al inquilino: cuánto lleva, cuánto ha pagado y qué riesgo tiene. */
@Injectable()
export class CustomerInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly insightsService: InsightsService,
  ) {}

  async insights(
    tenantId: string,
    customerId: string,
    opts: { facilityScope: FacilityScope; moneyVisible: boolean },
  ): Promise<CustomerInsightsDto> {
    const scope = opts.facilityScope;
    const inScope: Prisma.InvoiceWhereInput = scope
      ? { AND: [invoiceFacilityWhere(scope) as Prisma.InvoiceWhereInput] }
      : {};
    const since = new Date(Date.now() - 365 * DAY);
    const risk = await this.insightsService.getChurnRisk(
      tenantId,
      resolveAnalyticsScope(scope),
      customerId,
    );
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
      const [first, total, year, invoices, failed, returned] = await Promise.all([
        tx.contract.findFirst({
          where: { customerId, deletedAt: null, signedAt: { not: null } },
          orderBy: { signedAt: 'asc' },
          select: { signedAt: true },
        }),
        this.paid(tx, customerId, inScope),
        this.paid(tx, customerId, inScope, since),
        tx.invoice.findMany({
          where: {
            customerId,
            deletedAt: null,
            kind: 'invoice',
            status: { in: ['issued', 'overdue', 'paid'] },
            dueDate: { gte: since, not: null },
            ...inScope,
          },
          select: { status: true, dueDate: true, paidAt: true },
        }),
        tx.payment.count({ where: { customerId, status: 'failed', createdAt: { gte: since } } }),
        tx.payment.count({ where: { customerId, returnedAt: { gte: since } } }),
      ]);

      const customerSince = first?.signedAt ?? null;
      const tenureMonths = customerSince
        ? Math.floor((Date.now() - customerSince.getTime()) / (30.44 * DAY))
        : 0;
      const levels = risk.items.map((i) => i);
      const worst = levels.sort((a, b) => b.score - a.score)[0];
      const churn: CustomerInsightsDto['churn'] = worst
        ? { level: worst.level, score: worst.score, factors: worst.factors }
        : risk.summary.total > 0
          ? { level: 'low', score: 0, factors: [] }
          : null;

      let paymentRisk: CustomerInsightsDto['paymentRisk'] = null;
      if (opts.moneyVisible && invoices.length > 0) {
        const overdue = invoices.filter(
          (i) => i.status === 'overdue' || (i.status === 'issued' && i.dueDate! < today),
        ).length;
        const paid = invoices.filter((i) => i.paidAt);
        const late = paid.filter((i) => i.paidAt! > new Date(i.dueDate!.getTime() + DAY)).length;
        const reasons: string[] = [];
        if (overdue > 0) {
          reasons.push(`${overdue} ${plural(overdue, 'factura vencida', 'facturas vencidas')}`);
        }
        if (returned > 0) {
          reasons.push(`${returned} ${plural(returned, 'cobro devuelto', 'cobros devueltos')}`);
        }
        if (failed > 0) {
          reasons.push(`${failed} ${plural(failed, 'cobro fallido', 'cobros fallidos')}`);
        }
        if (late > 0) {
          reasons.push(`${late} de ${paid.length} pagadas con retraso`);
        }
        let level: CustomerRiskLevel = 'low';
        if (overdue >= 2 || returned >= 2 || failed >= 3) level = 'high';
        else if (overdue + returned + failed > 0 || late / Math.max(paid.length, 1) >= 0.3) {
          level = 'medium';
        }
        paymentRisk = { level, reasons };
      }

      return {
        customerSince: customerSince ? customerSince.toISOString() : null,
        tenureMonths,
        paidTotal: opts.moneyVisible ? total : null,
        paid12m: opts.moneyVisible ? year : null,
        churn,
        paymentRisk,
      };
    }, tenantId);
  }

  private async paid(
    tx: Prisma.TransactionClient,
    customerId: string,
    inScope: Prisma.InvoiceWhereInput,
    since?: Date,
  ): Promise<number> {
    const sum = await tx.payment.aggregate({
      where: {
        customerId,
        status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
        methodType: { notIn: ['credit_note', 'withholding'] },
        ...(since ? { paidAt: { gte: since } } : {}),
        ...('AND' in inScope ? { invoice: inScope } : {}),
      },
      _sum: { amount: true, refundedAmount: true },
    });
    return round2(Number(sum._sum.amount ?? 0) - Number(sum._sum.refundedAmount ?? 0));
  }
}
