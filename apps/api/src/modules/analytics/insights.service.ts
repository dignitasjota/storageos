import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  ApplyPricingResultDto,
  ChurnRiskItemDto,
  ChurnRiskKpiDto,
  ChurnRiskLevel,
  PricingAction,
  PricingSuggestionItemDto,
  PricingSuggestionsDto,
  RevenueForecastDto,
  RevenueForecastPointDto,
} from '@storageos/shared';

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function levelFor(score: number): ChurnRiskLevel {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Insights heurísticos (sin ML): riesgo de baja por contrato y sugerencias de
 * precio por ocupación (yield management). Todo read-only — no muta pricing
 * rules ni contratos; son recomendaciones para el operador.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Riesgo de baja (churn) por contrato activo.
  // ---------------------------------------------------------------------------
  async getChurnRisk(tenantId: string): Promise<ChurnRiskKpiDto> {
    return this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { status: { in: ['active', 'ending'] }, deletedAt: null },
        select: {
          id: true,
          contractNumber: true,
          customerId: true,
          priceMonthly: true,
          endDate: true,
          autoRenew: true,
          customer: {
            select: {
              id: true,
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
            },
          },
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
      });

      if (contracts.length === 0) {
        return { summary: { high: 0, medium: 0, low: 0, total: 0 }, items: [] };
      }

      const customerIds = [...new Set(contracts.map((c) => c.customerId))];

      const [overdue, failedPayments, dunning, defaultPms] = await Promise.all([
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { status: 'overdue', customerId: { in: customerIds } },
          _count: { _all: true },
          _sum: { total: true, amountPaid: true },
        }),
        tx.payment.groupBy({
          by: ['customerId'],
          where: { status: 'failed', customerId: { in: customerIds } },
          _count: { _all: true },
        }),
        tx.dunningAction.findMany({
          where: { status: 'executed', invoice: { customerId: { in: customerIds } } },
          select: { invoice: { select: { customerId: true } } },
        }),
        tx.paymentMethod.findMany({
          where: { customerId: { in: customerIds }, isDefault: true, deletedAt: null },
          select: { customerId: true },
        }),
      ]);

      const overdueByCustomer = new Map(
        overdue.map((o) => [
          o.customerId,
          {
            count: o._count._all,
            pending: round2(toNumber(o._sum.total) - toNumber(o._sum.amountPaid)),
          },
        ]),
      );
      const failedByCustomer = new Map(failedPayments.map((p) => [p.customerId, p._count._all]));
      const dunningByCustomer = new Map<string, number>();
      for (const d of dunning) {
        const cid = d.invoice?.customerId;
        if (cid) dunningByCustomer.set(cid, (dunningByCustomer.get(cid) ?? 0) + 1);
      }
      const customersWithPm = new Set(defaultPms.map((p) => p.customerId));

      const now = Date.now();
      const items: ChurnRiskItemDto[] = contracts.map((c) => {
        const price = toNumber(c.priceMonthly);
        const factors: string[] = [];
        let score = 0;

        const od = overdueByCustomer.get(c.customerId);
        if (od && od.count > 0) {
          score += 35;
          factors.push(od.count === 1 ? '1 factura vencida' : `${od.count} facturas vencidas`);
          if (od.count >= 2) score += 10;
          if (price > 0 && od.pending > price) {
            score += 10;
            factors.push('debe más de una mensualidad');
          }
        }

        const failed = failedByCustomer.get(c.customerId) ?? 0;
        if (failed > 0) {
          score += 20;
          factors.push(failed === 1 ? '1 cobro fallido' : `${failed} cobros fallidos`);
        }

        const dun = dunningByCustomer.get(c.customerId) ?? 0;
        if (dun > 0) {
          score += 15;
          factors.push('en proceso de reclamación (dunning)');
        }

        if (c.endDate) {
          const daysToEnd = Math.ceil((c.endDate.getTime() - now) / 86_400_000);
          if (daysToEnd >= 0 && daysToEnd <= 60 && !c.autoRenew) {
            score += 25;
            factors.push(`vence en ${daysToEnd} días sin renovación automática`);
          } else if (daysToEnd >= 0 && daysToEnd <= 30) {
            score += 10;
            factors.push(`vence en ${daysToEnd} días`);
          }
        }

        if (!customersWithPm.has(c.customerId)) {
          score += 15;
          factors.push('sin método de pago guardado');
        }

        score = Math.min(100, score);

        return {
          contractId: c.id,
          contractNumber: c.contractNumber,
          customerId: c.customerId,
          customerName: customerName(c.customer),
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          priceMonthly: price,
          score,
          level: levelFor(score),
          factors,
        };
      });

      const summary = {
        high: items.filter((i) => i.level === 'high').length,
        medium: items.filter((i) => i.level === 'medium').length,
        low: items.filter((i) => i.level === 'low').length,
        total: items.length,
      };

      // El detalle omite los `low` (sin señales relevantes) y ordena por riesgo.
      const detail = items
        .filter((i) => i.level !== 'low')
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);

      return { summary, items: detail };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // Sugerencias de precio por ocupación (yield management heurístico).
  // ---------------------------------------------------------------------------
  async getPricingSuggestions(tenantId: string): Promise<PricingSuggestionsDto> {
    return this.prisma.withTenant(async (tx) => {
      const [unitTypes, byType, occupiedByType] = await Promise.all([
        tx.unitType.findMany({ select: { id: true, name: true, defaultPriceMonthly: true } }),
        tx.unit.groupBy({ by: ['unitTypeId'], _count: { _all: true } }),
        tx.unit.groupBy({
          by: ['unitTypeId'],
          where: { status: 'occupied' },
          _count: { _all: true },
        }),
      ]);

      const totalByType = new Map(byType.map((g) => [g.unitTypeId, g._count._all]));
      const occByType = new Map(occupiedByType.map((g) => [g.unitTypeId, g._count._all]));

      const items: PricingSuggestionItemDto[] = [];
      for (const ut of unitTypes) {
        const total = totalByType.get(ut.id) ?? 0;
        if (total === 0) continue; // sin trasteros de este tipo: no hay señal
        const occupied = occByType.get(ut.id) ?? 0;
        const occupancy = round2((occupied / total) * 100);
        const currentPrice = toNumber(ut.defaultPriceMonthly);

        let changePct = 0;
        let action: PricingAction = 'hold';
        let rationale = 'Ocupación equilibrada: mantener el precio.';
        if (occupancy >= 90) {
          changePct = 10;
          action = 'raise';
          rationale = 'Ocupación muy alta (≥90%): hay margen para subir el precio.';
        } else if (occupancy >= 80) {
          changePct = 5;
          action = 'raise';
          rationale = 'Ocupación alta (≥80%): subida moderada recomendada.';
        } else if (occupancy <= 40) {
          changePct = -10;
          action = 'lower';
          rationale = 'Ocupación baja (≤40%): bajar el precio para estimular la demanda.';
        } else if (occupancy <= 60) {
          changePct = -5;
          action = 'lower';
          rationale = 'Ocupación floja (≤60%): bajada moderada para captar demanda.';
        }

        items.push({
          unitTypeId: ut.id,
          unitTypeName: ut.name,
          totalUnits: total,
          occupiedUnits: occupied,
          occupancy,
          currentPrice,
          suggestedPrice: round2(currentPrice * (1 + changePct / 100)),
          changePct,
          action,
          rationale,
        });
      }

      items.sort((a, b) => b.occupancy - a.occupancy);
      return { items };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // Forecasting de ocupación e ingresos (proyección por tendencia, sin ML).
  // ---------------------------------------------------------------------------
  async getRevenueForecast(
    tenantId: string,
    opts: { months?: number; trailingMonths?: number } = {},
  ): Promise<RevenueForecastDto> {
    const horizon = Math.min(24, Math.max(1, opts.months ?? 6));
    const trailing = Math.min(24, Math.max(1, opts.trailingMonths ?? 6));

    return this.prisma.withTenant(async (tx) => {
      const [totalUnits, occupiedUnits, activeContracts, history] = await Promise.all([
        tx.unit.count(),
        tx.unit.count({ where: { status: 'occupied' } }),
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, deletedAt: null },
          select: { priceMonthly: true, discountAmount: true },
        }),
        tx.contract.findMany({
          where: { signedAt: { not: null } },
          select: { signedAt: true, endedAt: true },
        }),
      ]);

      const mrr = round2(
        activeContracts.reduce(
          (sum, c) => sum + (toNumber(c.priceMonthly) - toNumber(c.discountAmount)),
          0,
        ),
      );
      const activeCount = activeContracts.length;
      const avgContractValue = activeCount > 0 ? round2(mrr / activeCount) : 0;
      const currentOccupancy = totalUnits > 0 ? round2(occupiedUnits / totalUnits) : 0;

      // Medias móviles de los `trailing` meses cerrados (excluye el mes en curso).
      const now = new Date();
      let churnRateSum = 0;
      let churnRateCount = 0;
      let addsSum = 0;
      for (let i = 1; i <= trailing; i++) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
        const startMs = monthStart.getTime();
        const endMs = monthEnd.getTime();

        let activeAtStart = 0;
        let ended = 0;
        let adds = 0;
        for (const c of history) {
          const signed = c.signedAt!.getTime();
          const endedAt = c.endedAt?.getTime() ?? null;
          if (signed < startMs && (endedAt === null || endedAt >= startMs)) activeAtStart += 1;
          if (endedAt !== null && endedAt >= startMs && endedAt < endMs) ended += 1;
          if (signed >= startMs && signed < endMs) adds += 1;
        }
        if (activeAtStart > 0) {
          churnRateSum += ended / activeAtStart;
          churnRateCount += 1;
        }
        addsSum += adds;
      }
      const monthlyChurnRate = churnRateCount > 0 ? round2(churnRateSum / churnRateCount) : 0;
      const avgMonthlyNewContracts = round2(addsSum / trailing);

      // Proyección mes a mes: decae por churn, crece por altas medias.
      const points: RevenueForecastPointDto[] = [];
      let prevActive = activeCount;
      for (let m = 1; m <= horizon; m++) {
        const projected = Math.max(
          0,
          Math.round(prevActive - prevActive * monthlyChurnRate + avgMonthlyNewContracts),
        );
        const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
        const yearMonth = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}`;
        points.push({
          yearMonth,
          projectedActiveContracts: projected,
          projectedMrr: round2(projected * avgContractValue),
          projectedOccupancy: totalUnits > 0 ? round2(Math.min(1, projected / totalUnits)) : 0,
        });
        prevActive = projected;
      }

      return {
        current: { activeContracts: activeCount, mrr, totalUnits, occupancy: currentOccupancy },
        assumptions: {
          monthlyChurnRate,
          avgMonthlyNewContracts,
          avgContractValue,
          trailingMonths: trailing,
        },
        points,
      };
    }, tenantId);
  }

  /**
   * Aplica el precio sugerido a un tipo de trastero: actualiza su
   * `defaultPriceMonthly` (precio de catálogo para nuevos contratos). No toca
   * los contratos activos — para subir la cartera existe ECRI (rent-increases).
   */
  async applyPricing(args: {
    tenantId: string;
    userId: string;
    unitTypeId: string;
    price: number;
    meta: RequestMeta;
  }): Promise<ApplyPricingResultDto> {
    const result = await this.prisma.withTenant(async (tx) => {
      const ut = await tx.unitType.findUnique({ where: { id: args.unitTypeId } });
      if (!ut) {
        throw new NotFoundException({
          code: 'unit_type_not_found',
          message: 'Tipo de trastero no encontrado',
        });
      }
      const previousPrice = toNumber(ut.defaultPriceMonthly);
      const newPrice = round2(args.price);
      await tx.unitType.update({
        where: { id: args.unitTypeId },
        data: { defaultPriceMonthly: newPrice },
      });
      return { previousPrice, newPrice };
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'pricing.suggestion_applied',
      entityType: 'UnitType',
      entityId: args.unitTypeId,
      changes: { from: result.previousPrice, to: result.newPrice },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      unitTypeId: args.unitTypeId,
      previousPrice: result.previousPrice,
      newPrice: result.newPrice,
    };
  }
}
