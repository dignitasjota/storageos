import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { toActiveUnitOffer } from '../promotions/promotions.service';

import {
  daysBetween,
  decidePrice,
  demandFactors,
  fitMarketCurve,
  marketConfidence,
  median,
  MIN_OBSERVED_RENTALS,
  observationWeight,
  observedRentals,
  effectiveMonthlyPrice,
  marketTrend,
  rentalIntervals,
  statusAt,
  featureMultiplier,
  type MarketCurve,
} from './pricing-engine';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  ApplyPricingResultDto,
  ApplyUnitPricingResultDto,
  ChurnRiskItemDto,
  ChurnRiskKpiDto,
  ChurnRiskLevel,
  PriceChangeEffectDto,
  PriceChangeEffectsDto,
  PriceChangeEffectsSummaryDto,
  PricingStrategyDto,
  PricingSuggestionItemDto,
  PricingSuggestionsDto,
  RevenueForecastDto,
  RevenueForecastPointDto,
  SuggestedActionDto,
  SuggestedActionsDto,
  UnitPricingFactorDto,
  UnitPricingSuggestionDto,
  UnitPricingSuggestionsDto,
  UpdatePricingStrategyInput,
} from '@storageos/shared';

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Pricing por competencia: banda de tamaño (±%) para casar trasteros por m²,
// margen de precio para decidir caro/barato, y el ajuste que aporta el factor.
/** A partir de estos días libre se propone una promoción en vez de bajar el precio. */
const PROMOTION_AFTER_DAYS = 45;

const signed = (n: number) => `${n > 0 ? '+' : ''}${n} %`;

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

  /**
   * «Sugerencias de hoy»: acciones concretas priorizadas cruzando las señales que
   * ya calcula el sistema (riesgo de baja, precio por debajo de mercado, facturas
   * vencidas, contratos que vencen sin renovación). Determinista (no depende de la
   * IA) → funciona en cualquier entorno; cada acción enlaza al recurso exacto.
   */
  async getSuggestedActions(tenantId: string): Promise<SuggestedActionsDto> {
    const [churn, pricing, extra] = await Promise.all([
      this.getChurnRisk(tenantId),
      this.getUnitPricingSuggestions(tenantId),
      this.prisma.withTenant(async (tx) => {
        const now = new Date();
        const in30 = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
        const [overdue, endingSoon] = await Promise.all([
          tx.invoice.aggregate({
            where: { status: 'overdue', deletedAt: null },
            _count: { _all: true },
            _sum: { total: true, amountPaid: true },
          }),
          tx.contract.findMany({
            where: {
              status: { in: ['active', 'ending'] },
              autoRenew: false,
              deletedAt: null,
              endDate: { not: null, gte: now, lte: in30 },
            },
            select: {
              id: true,
              contractNumber: true,
              endDate: true,
              customer: {
                select: {
                  customerType: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                },
              },
            },
            orderBy: { endDate: 'asc' },
            take: 3,
          }),
        ]);
        return { overdue, endingSoon };
      }, tenantId),
    ]);

    const actions: SuggestedActionDto[] = [];

    // 1) Cobros: facturas vencidas por reclamar.
    const overdueCount = extra.overdue._count._all;
    if (overdueCount > 0) {
      const pending = round2(
        toNumber(extra.overdue._sum.total) - toNumber(extra.overdue._sum.amountPaid),
      );
      actions.push({
        id: 'collections',
        category: 'collections',
        priority: pending >= 300 || overdueCount >= 3 ? 'high' : 'medium',
        title: `Reclama ${overdueCount} factura${overdueCount === 1 ? '' : 's'} vencida${
          overdueCount === 1 ? '' : 's'
        }`,
        detail: `${pending.toFixed(2)} € pendientes de cobro`,
        href: '/invoices?status=overdue',
        cta: 'Ver facturas',
      });
    }

    // 2) Retención: inquilinos con riesgo de baja ALTO (top 3).
    for (const item of churn.items.filter((i) => i.level === 'high').slice(0, 3)) {
      actions.push({
        id: `retention-${item.contractId}`,
        category: 'retention',
        priority: 'high',
        title: `Contacta a ${item.customerName}`,
        detail: `Riesgo de baja alto${
          item.factors.length ? ` · ${item.factors.slice(0, 2).join(', ')}` : ''
        }`,
        href: `/customers/${item.customerId}`,
        cta: 'Ver inquilino',
      });
    }

    // 3) Precio: trasteros por debajo de mercado (mayor subida sugerida, top 2).
    const toRaise = pricing.items
      .filter((s) => s.action === 'raise')
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 2);
    for (const u of toRaise) {
      actions.push({
        id: `pricing-${u.unitId}`,
        category: 'pricing',
        priority: 'medium',
        title: `Sube el precio de ${u.code}`,
        detail: `Sugerido ${u.suggestedPrice.toFixed(2)} € (+${u.changePct}% vs ${u.currentPrice.toFixed(
          2,
        )} €)`,
        href: '/analytics',
        cta: 'Ver precios',
      });
    }

    // 4) Renovaciones: contratos que vencen en 30 días sin renovación automática.
    for (const c of extra.endingSoon) {
      const name = customerName(c.customer);
      const when = c.endDate ? new Date(c.endDate).toLocaleDateString('es-ES') : '';
      actions.push({
        id: `renewal-${c.id}`,
        category: 'renewal',
        priority: 'medium',
        title: `${name} vence pronto`,
        detail: `Contrato ${c.contractNumber} vence el ${when} sin renovación automática`,
        href: `/contracts/${c.id}`,
        cta: 'Ver contrato',
      });
    }

    // Prioriza (alta primero) y limita a 6 para no saturar el dashboard.
    const order: Record<SuggestedActionDto['priority'], number> = { high: 0, medium: 1 };
    actions.sort((a, b) => order[a.priority] - order[b.priority]);
    return { actions: actions.slice(0, 6), aiEnhanced: false };
  }

  // ---------------------------------------------------------------------------
  // Precio sugerido (motor único: ver `pricing-engine.ts`).
  // Precio objetivo = mercado del tamaño × posicionamiento del local × demanda,
  // con límites (cambio máximo por vez, mínimo/máximo del tipo y espera entre
  // cambios). Lo comparten la vista por tipo y la vista por trastero.
  // ---------------------------------------------------------------------------

  /** Datos comunes del cálculo: estrategia, competencia, ocupación y listas de espera. */
  private async loadPricingContext(tx: Prisma.TransactionClient, tenantId: string) {
    const since90 = new Date(Date.now() - 90 * 86_400_000);
    const since60 = new Date(Date.now() - 60 * 86_400_000);
    const [
      tenant,
      facilities,
      unitTypes,
      competitors,
      totals,
      occupied,
      waitlist,
      available,
      recent,
      leadRows,
    ] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          pricingTargetOccupancy: true,
          pricingMaxStepPct: true,
          pricingMinDaysBetweenChanges: true,
        },
      }),
      tx.facility.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          city: true,
          pricingPositioningPct: true,
          features: true,
        },
      }),
      tx.unitType.findMany({
        select: {
          id: true,
          name: true,
          defaultPriceMonthly: true,
          minPriceMonthly: true,
          maxPriceMonthly: true,
        },
      }),
      tx.competitorFacility.findMany({
        select: {
          facilityId: true,
          zone: true,
          distanceKm: true,
          priceIncludesVat: true,
          mandatoryInsuranceMonthly: true,
          setupFee: true,
          promoFreeMonths: true,
          promoDiscountPct: true,
          promoDiscountMonths: true,
          features: true,
          inventoryComplete: true,
          units: {
            select: {
              areaM2: true,
              priceMonthly: true,
              status: true,
              lastCheckedAt: true,
              observations: {
                orderBy: { observedAt: 'asc' },
                select: { observedAt: true, status: true, priceMonthly: true },
              },
            },
          },
        },
      }),
      tx.unit.groupBy({ by: ['facilityId', 'unitTypeId'], _count: { _all: true } }),
      // Un reservado ya no está a la venta: cuenta como ocupado.
      tx.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { status: { in: ['occupied', 'reserved'] } },
        _count: { _all: true },
      }),
      tx.waitlistEntry.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { status: 'waiting' },
        _count: { _all: true },
      }),
      tx.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { status: 'available' },
        _count: { _all: true },
      }),
      // Mis alquileres de los últimos 90 días (contratos firmados), por tamaño.
      tx.contract.findMany({
        where: { signedAt: { gte: since90 }, deletedAt: null, status: { not: 'cancelled' } },
        select: { unit: { select: { facilityId: true, unitTypeId: true } } },
      }),
      // Contactos que piden un tamaño: abiertos recientes y perdidos por precio.
      tx.lead.findMany({
        where: {
          deletedAt: null,
          preferredUnitTypeId: { not: null },
          OR: [
            { status: { in: ['new', 'contacted', 'qualified'] }, createdAt: { gte: since60 } },
            { status: 'lost', lostReasonCode: 'too_expensive', lostAt: { gte: since90 } },
          ],
        },
        select: { status: true, preferredFacilityId: true, preferredUnitTypeId: true },
      }),
    ]);

    const key = (f: string, t: string) => `${f}:${t}`;
    const totalMap = new Map(totals.map((g) => [key(g.facilityId, g.unitTypeId), g._count._all]));
    const occMap = new Map(occupied.map((g) => [key(g.facilityId, g.unitTypeId), g._count._all]));
    const waitMap = new Map(waitlist.map((g) => [key(g.facilityId, g.unitTypeId), g._count._all]));
    const availMap = new Map(
      available.map((g) => [key(g.facilityId, g.unitTypeId), g._count._all]),
    );
    const rentalsMap = new Map<string, number>();
    for (const c of recent) {
      const k = key(c.unit.facilityId, c.unit.unitTypeId);
      rentalsMap.set(k, (rentalsMap.get(k) ?? 0) + 1);
    }
    const facilityTotals = new Map<string, { total: number; occupied: number }>();
    for (const g of totals) {
      const acc = facilityTotals.get(g.facilityId) ?? { total: 0, occupied: 0 };
      acc.total += g._count._all;
      acc.occupied += occMap.get(key(g.facilityId, g.unitTypeId)) ?? 0;
      facilityTotals.set(g.facilityId, acc);
    }

    const now = new Date();
    const norm = (s: string | null | undefined) =>
      (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    // Precio comparable: lo que paga de media un cliente el primer año, sin IVA
    // (seguro obligatorio y alta incluidos, promoción descontada).
    const comparable = competitors.map((c) => ({
      ...c,
      units: c.units.map((u) => {
        const gross = effectiveMonthlyPrice({
          price: toNumber(u.priceMonthly),
          insuranceMonthly: toNumber(c.mandatoryInsuranceMonthly),
          setupFee: toNumber(c.setupFee),
          promoFreeMonths: c.promoFreeMonths ?? 0,
          promoDiscountPct: c.promoDiscountPct ?? 0,
          promoDiscountMonths: c.promoDiscountMonths ?? 0,
        });
        return {
          areaM2: toNumber(u.areaM2),
          price: c.priceIncludesVat ? gross / 1.21 : gross,
          occupied: u.status === 'occupied',
          ageDays: daysBetween(u.lastCheckedAt, now),
          rentals: observedRentals(u.observations),
          priceObservations: u.observations.map((o) => ({
            observedAt: o.observedAt,
            price: toNumber(o.priceMonthly),
          })),
        };
      }),
    }));

    /** Cercanía de un competidor a un local (null = vista general por tipo). */
    const proximityFor = (
      c: (typeof comparable)[number],
      facility: { id: string; city: string | null } | null,
    ) => ({
      linkedToFacility: facility ? c.facilityId === facility.id : c.facilityId != null,
      // La distancia es al local con el que compite: solo vale si no está ligado a otro.
      distanceKm:
        c.distanceKm != null && (c.facilityId == null || c.facilityId === facility?.id)
          ? toNumber(c.distanceKm)
          : null,
      sameZone: facility != null && norm(c.zone) !== '' && norm(c.zone) === norm(facility.city),
    });

    const curveCache = new Map<string, MarketCurve | null>();
    const marketCurve = (
      facility: { id: string; city: string | null; features?: string[] } | null,
    ) => {
      const cacheKey = facility?.id ?? '*';
      if (!curveCache.has(cacheKey)) {
        const obs = comparable.flatMap((c) => {
          const prox = proximityFor(c, facility);
          // Lleva su precio a las características de mi local (sin local: tal cual).
          const mult = facility ? featureMultiplier(facility.features ?? [], c.features) : 1;
          return c.units.map((u) => ({
            areaM2: u.areaM2,
            price: u.price * mult,
            weight: observationWeight({ ageDays: u.ageDays, ...prox }),
          }));
        });
        curveCache.set(cacheKey, fitMarketCurve(obs));
      }
      return curveCache.get(cacheKey) ?? null;
    };

    /**
     * Ocupación de la competencia cercana para un tamaño (±25 % de m²), solo de
     * competidores con el inventario completo. Null con menos de 3 trasteros.
     */
    const competitorOccupancy = (
      facility: { id: string; city: string | null } | null,
      areaM2: number,
    ) => {
      let total = 0;
      let occ = 0;
      for (const c of comparable) {
        if (!c.inventoryComplete) continue;
        const near = observationWeight({ ageDays: 0, ...proximityFor(c, facility) }) >= 0.5;
        if (!near) continue;
        for (const u of c.units) {
          if (Math.abs(u.areaM2 - areaM2) > areaM2 * 0.25) continue;
          total += 1;
          if (u.occupied) occ += 1;
        }
      }
      return total >= 3 ? occ / total : null;
    };

    /**
     * Cuánto tarda la competencia cercana en alquilar un tamaño (±25 % de m²),
     * según los pasos de libre a ocupado de sus revisiones.
     */
    const competitorDaysToRent = (
      facility: { id: string; city: string | null } | null,
      areaM2: number,
    ) => {
      const durations: number[] = [];
      for (const c of comparable) {
        const near = observationWeight({ ageDays: 0, ...proximityFor(c, facility) }) >= 0.5;
        if (!near) continue;
        for (const u of c.units) {
          if (Math.abs(u.areaM2 - areaM2) > areaM2 * 0.25) continue;
          durations.push(...u.rentals);
        }
      }
      return durations.length >= MIN_OBSERVED_RENTALS
        ? { medianDays: median(durations), rentals: durations.length }
        : null;
    };

    return {
      now,
      targetOccupancy: (tenant?.pricingTargetOccupancy ?? 88) / 100,
      maxStepPct: tenant?.pricingMaxStepPct ?? 8,
      minDaysBetweenChanges: tenant?.pricingMinDaysBetweenChanges ?? 30,
      facilities,
      unitTypes,
      hasCompetitors: comparable.some((c) => c.units.length > 0),
      /** Contactos de un tamaño (de ese local o sin local; sin local = todos). */
      leadsFor: (facilityId: string | null, unitTypeId: string) => {
        let open = 0;
        let lostTooExpensive = 0;
        for (const l of leadRows) {
          if (l.preferredUnitTypeId !== unitTypeId) continue;
          if (facilityId && l.preferredFacilityId && l.preferredFacilityId !== facilityId) continue;
          if (l.status === 'lost') lostTooExpensive += 1;
          else open += 1;
        }
        return { open, lostTooExpensive };
      },
      dim: (facilityId: string, unitTypeId: string) => ({
        total: totalMap.get(key(facilityId, unitTypeId)) ?? 0,
        occupied: occMap.get(key(facilityId, unitTypeId)) ?? 0,
        waitlist: waitMap.get(key(facilityId, unitTypeId)) ?? 0,
        available: availMap.get(key(facilityId, unitTypeId)) ?? 0,
        rentals90: rentalsMap.get(key(facilityId, unitTypeId)) ?? 0,
      }),
      facilityOccupancy: (facilityId: string) => {
        const t = facilityTotals.get(facilityId);
        return t && t.total > 0 ? t.occupied / t.total : 0;
      },
      marketCurve,
      competitorOccupancy,
      competitorDaysToRent,
      /** Tendencia de precios de la competencia cercana (sin local: toda). */
      marketTrendFor: (facility: { id: string; city: string | null } | null) => {
        const units = comparable
          .filter(
            (c) =>
              !facility || observationWeight({ ageDays: 0, ...proximityFor(c, facility) }) >= 0.5,
          )
          .flatMap((c) => c.units.map((u) => ({ observations: u.priceObservations })));
        return marketTrend(units, now);
      },
    };
  }

  /** Sugerencia por TIPO de trastero (precio de catálogo para nuevos contratos). */
  async getPricingSuggestions(tenantId: string): Promise<PricingSuggestionsDto> {
    return this.prisma.withTenant(async (tx) => {
      const ctx = await this.loadPricingContext(tx, tenantId);
      const areas = await tx.unit.groupBy({
        by: ['unitTypeId'],
        _avg: { areaM2: true },
      });
      const avgArea = new Map(areas.map((a) => [a.unitTypeId, toNumber(a._avg.areaM2)]));
      const curve = ctx.marketCurve(null);

      const items: PricingSuggestionItemDto[] = [];
      for (const ut of ctx.unitTypes) {
        // Agrega el tipo en todos los locales.
        let total = 0;
        let occupied = 0;
        let waiting = 0;
        let free = 0;
        let rentals90 = 0;
        let positioningWeighted = 0;
        for (const f of ctx.facilities) {
          const d = ctx.dim(f.id, ut.id);
          total += d.total;
          occupied += d.occupied;
          waiting += d.waitlist;
          free += d.available;
          rentals90 += d.rentals90;
          positioningWeighted += f.pricingPositioningPct * d.total;
        }
        if (total === 0) continue; // sin trasteros de este tipo: no hay señal
        const area = avgArea.get(ut.id) ?? 0;
        const marketPrice = curve && area > 0 ? curve.priceAt(area) : null;
        const confidence = area > 0 ? marketConfidence(curve, area) : 'low';
        const factors = demandFactors({
          dimOccupied: occupied,
          dimTotal: total,
          facilityOccupancy: occupied / total,
          targetOccupancy: ctx.targetOccupancy,
          waitlist: waiting,
          competitorOccupancy: area > 0 ? ctx.competitorOccupancy(null, area) : null,
          competitorDaysToRent: area > 0 ? ctx.competitorDaysToRent(null, area) : null,
          ownRentals: { rentals90, available: free },
          leads: ctx.leadsFor(null, ut.id),
        });
        const demandPct = factors.reduce((s, f) => s + f.contribution, 0);
        const currentPrice = toNumber(ut.defaultPriceMonthly);
        const decision = decidePrice({
          currentPrice,
          marketPrice,
          // Posicionamiento medio de los locales, ponderado por sus trasteros de este tipo.
          positioningPct:
            marketPrice != null && total > 0 ? Math.round(positioningWeighted / total) : 0,
          demandPct,
          confidence,
          maxStepPct: ctx.maxStepPct,
          minPrice: ut.minPriceMonthly != null ? toNumber(ut.minPriceMonthly) : null,
          maxPrice: ut.maxPriceMonthly != null ? toNumber(ut.maxPriceMonthly) : null,
          daysSinceLastChange: null,
          minDaysBetweenChanges: ctx.minDaysBetweenChanges,
        });

        const parts: string[] = [];
        if (marketPrice != null) parts.push(`mercado ~${Math.round(marketPrice)} €`);
        for (const f of factors) parts.push(`${f.label.toLowerCase()} ${signed(f.contribution)}`);
        const rationale =
          decision.holdReason ??
          (parts.length ? `Objetivo ${decision.targetPrice} €: ${parts.join(', ')}.` : '');

        items.push({
          unitTypeId: ut.id,
          unitTypeName: ut.name,
          totalUnits: total,
          occupiedUnits: occupied,
          occupancy: round2((occupied / total) * 100),
          currentPrice,
          suggestedPrice: decision.suggestedPrice,
          changePct: decision.changePct,
          action: decision.action,
          rationale,
          marketPrice: marketPrice != null ? round2(marketPrice) : null,
          confidence,
          marketTrend: ctx.marketTrendFor(null),
        });
      }

      items.sort((a, b) => b.occupancy - a.occupancy);
      return { items };
    }, tenantId);
  }

  /**
   * Sugerencia por TRASTERO disponible. Aplicar fija `unit.basePriceMonthly`
   * (solo afecta a nuevos contratos). Dos trasteros iguales del mismo local
   * reciben el mismo precio; el tiempo vacío no baja el precio, propone una
   * promoción.
   */
  async getUnitPricingSuggestions(
    tenantId: string,
    facilityId?: string,
    includeCompetition = true,
  ): Promise<UnitPricingSuggestionsDto> {
    return this.prisma.withTenant(async (tx) => {
      const units = await tx.unit.findMany({
        where: { status: 'available', ...(facilityId ? { facilityId } : {}) },
        include: {
          unitType: { select: { id: true, name: true } },
          facility: { select: { name: true } },
        },
      });
      if (units.length === 0) return { items: [] };

      const ctx = await this.loadPricingContext(tx, tenantId);
      const unitIds = units.map((u) => u.id);
      const [history, lastChanges, promos] = await Promise.all([
        // Días vacío: último paso a `available` (si no hay, desde el alta).
        tx.unitStatusHistory.findMany({
          where: { unitId: { in: unitIds }, newStatus: 'available' },
          orderBy: { occurredAt: 'desc' },
          select: { unitId: true, occurredAt: true },
        }),
        tx.unitPriceHistory.groupBy({
          by: ['unitId'],
          where: { unitId: { in: unitIds } },
          _max: { changedAt: true },
        }),
        // Ofertas de trastero activas (creadas a mano desde esta vista).
        tx.promotion.findMany({
          where: {
            isActive: true,
            discountType: 'free_months',
            OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
          },
        }),
      ]);
      const offerByUnit = new Map(
        promos
          .map((p) => toActiveUnitOffer(p))
          .filter((o): o is NonNullable<typeof o> => o !== null)
          .map((o) => [o.unitId, o]),
      );
      const vacantSince = new Map<string, Date>();
      for (const h of history)
        if (!vacantSince.has(h.unitId)) vacantSince.set(h.unitId, h.occurredAt);
      const lastChange = new Map(lastChanges.map((c) => [c.unitId, c._max.changedAt]));
      const facilityById = new Map(ctx.facilities.map((f) => [f.id, f]));
      const typeById = new Map(ctx.unitTypes.map((t) => [t.id, t]));

      const items: UnitPricingSuggestionDto[] = units.map((u) => {
        const facility = facilityById.get(u.facilityId) ?? {
          id: u.facilityId,
          name: u.facility.name,
          city: null,
          pricingPositioningPct: 0,
          features: [] as string[],
        };
        const type = typeById.get(u.unitTypeId);
        const d = ctx.dim(u.facilityId, u.unitTypeId);
        const area = toNumber(u.areaM2);
        const curve = includeCompetition ? ctx.marketCurve(facility) : null;
        const marketPrice = curve && area > 0 ? curve.priceAt(area) : null;
        const confidence = includeCompetition && area > 0 ? marketConfidence(curve, area) : 'low';

        const demand = demandFactors({
          dimOccupied: d.occupied,
          dimTotal: d.total,
          facilityOccupancy: ctx.facilityOccupancy(u.facilityId),
          targetOccupancy: ctx.targetOccupancy,
          waitlist: d.waitlist,
          competitorOccupancy:
            includeCompetition && area > 0 ? ctx.competitorOccupancy(facility, area) : null,
          competitorDaysToRent:
            includeCompetition && area > 0 ? ctx.competitorDaysToRent(facility, area) : null,
          ownRentals: { rentals90: d.rentals90, available: d.available },
          leads: ctx.leadsFor(u.facilityId, u.unitTypeId),
        });
        const demandPct = demand.reduce((s, f) => s + f.contribution, 0);
        const positioningPct = marketPrice != null ? facility.pricingPositioningPct : 0;

        const currentPrice = toNumber(u.basePriceMonthly);
        const changedAt = lastChange.get(u.id);
        const decision = decidePrice({
          currentPrice,
          marketPrice,
          positioningPct,
          demandPct,
          confidence,
          maxStepPct: ctx.maxStepPct,
          minPrice: type?.minPriceMonthly != null ? toNumber(type.minPriceMonthly) : null,
          maxPrice: type?.maxPriceMonthly != null ? toNumber(type.maxPriceMonthly) : null,
          daysSinceLastChange: changedAt ? daysBetween(changedAt, ctx.now) : null,
          minDaysBetweenChanges: ctx.minDaysBetweenChanges,
        });

        const factors: UnitPricingFactorDto[] = [];
        if (marketPrice != null) {
          factors.push({
            label: 'Mercado',
            detail: `~${Math.round(marketPrice)} €/mes para ${area} m² (${curve!.points} ref.)`,
            contribution: 0,
          });
          if (positioningPct !== 0) {
            factors.push({
              label: 'Tu posicionamiento',
              detail: positioningPct > 0 ? 'Por encima del mercado' : 'Por debajo del mercado',
              contribution: positioningPct,
            });
          }
        }
        for (const f of demand) {
          factors.push({ label: f.label, detail: f.detail, contribution: f.contribution });
        }

        const since = vacantSince.get(u.id) ?? u.createdAt;
        const daysVacant = daysBetween(since, ctx.now);
        const offer = offerByUnit.get(u.id) ?? null;
        const promotionHint =
          !offer && daysVacant >= PROMOTION_AFTER_DAYS
            ? `Lleva ${daysVacant} días libre: mejor una promoción para este trastero (p. ej. el primer mes a mitad de precio) que bajar el precio de todo el tamaño.`
            : null;

        return {
          unitId: u.id,
          code: u.code,
          unitTypeName: u.unitType?.name ?? null,
          facilityId: u.facilityId,
          facilityName: u.facility.name,
          occupancyPct: d.total > 0 ? round2((d.occupied / d.total) * 100) : 0,
          daysVacant,
          currentPrice,
          suggestedPrice: decision.suggestedPrice,
          changePct: decision.changePct,
          action: decision.action,
          factors,
          marketPrice: marketPrice != null ? round2(marketPrice) : null,
          marketReferences: curve?.points ?? 0,
          confidence,
          marketTrend: includeCompetition ? ctx.marketTrendFor(facility) : null,
          targetPrice: decision.targetPrice,
          holdReason: decision.holdReason,
          promotionHint,
          activeOffer: offer
            ? {
                promotionId: offer.promotionId,
                code: offer.code,
                freeMonths: offer.freeMonths,
                validUntil: offer.validUntil,
              }
            : null,
        };
      });

      // Primero los que más piden acción (mayor cambio absoluto), luego más vacíos.
      items.sort(
        (a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || b.daysVacant - a.daysVacant,
      );
      return { items };
    }, tenantId);
  }

  /**
   * Efecto de tus cambios de precio en la demanda (informativo): por cada cambio
   * de los últimos 12 meses en un trastero libre, cuánto tardó luego en
   * alquilarse frente a lo que tardaba ese tamaño en los 180 días anteriores.
   */
  async getPriceChangeEffects(tenantId: string): Promise<PriceChangeEffectsDto> {
    return this.prisma.withTenant(async (tx) => {
      const now = new Date();
      const changes = await tx.unitPriceHistory.findMany({
        where: { changedAt: { gte: new Date(now.getTime() - 365 * 86_400_000) } },
        orderBy: { changedAt: 'desc' },
        take: 200,
        include: {
          unit: {
            select: {
              id: true,
              code: true,
              facilityId: true,
              unitTypeId: true,
              unitType: { select: { name: true } },
              facility: { select: { name: true } },
            },
          },
        },
      });
      const empty = { changes: 0, rented: 0, avgDaysAfter: null, avgBaselineDays: null };
      if (changes.length === 0) return { items: [], raises: { ...empty }, lowers: { ...empty } };

      // Historial de todos los trasteros de los tamaños afectados.
      const dims = [...new Set(changes.map((c) => `${c.unit.facilityId}:${c.unit.unitTypeId}`))];
      const dimUnits = await tx.unit.findMany({
        where: {
          OR: dims.map((d) => {
            const [facilityId, unitTypeId] = d.split(':') as [string, string];
            return { facilityId, unitTypeId };
          }),
        },
        select: { id: true, facilityId: true, unitTypeId: true, createdAt: true },
      });
      const history = await tx.unitStatusHistory.findMany({
        where: { unitId: { in: dimUnits.map((u) => u.id) } },
        select: { unitId: true, occurredAt: true, newStatus: true },
      });
      const historyByUnit = new Map<string, { occurredAt: Date; newStatus: string }[]>();
      for (const h of history) {
        const list = historyByUnit.get(h.unitId) ?? [];
        list.push({ occurredAt: h.occurredAt, newStatus: h.newStatus });
        historyByUnit.set(h.unitId, list);
      }
      const intervalsByUnit = new Map(
        dimUnits.map((u) => [u.id, rentalIntervals(u.createdAt, historyByUnit.get(u.id) ?? [])]),
      );
      const unitsByDim = new Map<string, string[]>();
      for (const u of dimUnits) {
        const k = `${u.facilityId}:${u.unitTypeId}`;
        unitsByDim.set(k, [...(unitsByDim.get(k) ?? []), u.id]);
      }

      const items: PriceChangeEffectDto[] = [];
      for (const c of changes) {
        const unitHistory = historyByUnit.get(c.unitId) ?? [];
        // Solo cuenta si estaba a la venta: el precio afecta a contratos nuevos.
        if (statusAt(unitHistory, c.changedAt) !== 'available') continue;
        const at = c.changedAt.getTime();
        const after = (intervalsByUnit.get(c.unitId) ?? []).find(
          (i) => i.from.getTime() <= at && i.to.getTime() >= at,
        );
        const baselineFrom = at - 180 * 86_400_000;
        const baseline = (unitsByDim.get(`${c.unit.facilityId}:${c.unit.unitTypeId}`) ?? [])
          .flatMap((id) => intervalsByUnit.get(id) ?? [])
          .filter((i) => i.to.getTime() < at && i.to.getTime() >= baselineFrom)
          .map((i) => daysBetween(i.from, i.to));
        const previousPrice = toNumber(c.previousPrice);
        const newPrice = toNumber(c.newPrice);
        items.push({
          unitId: c.unitId,
          code: c.unit.code,
          unitTypeName: c.unit.unitType?.name ?? null,
          facilityName: c.unit.facility.name,
          changedAt: c.changedAt.toISOString(),
          previousPrice,
          newPrice,
          changePct:
            previousPrice > 0 ? round2(((newPrice - previousPrice) / previousPrice) * 100) : 0,
          source: c.source,
          daysToRentAfter: after ? daysBetween(c.changedAt, after.to) : null,
          stillFreeDays: after ? null : daysBetween(c.changedAt, now),
          baselineMedianDays: baseline.length > 0 ? round2(median(baseline)) : null,
          baselineRentals: baseline.length,
        });
      }

      const summarize = (rows: PriceChangeEffectDto[]): PriceChangeEffectsSummaryDto => {
        const rented = rows.filter((r) => r.daysToRentAfter !== null);
        const withBase = rented.filter((r) => r.baselineMedianDays !== null);
        const avg = (xs: number[]) =>
          xs.length > 0 ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
        return {
          changes: rows.length,
          rented: rented.length,
          avgDaysAfter: avg(rented.map((r) => r.daysToRentAfter!)),
          avgBaselineDays: avg(withBase.map((r) => r.baselineMedianDays!)),
        };
      };
      return {
        items: items.slice(0, 50),
        raises: summarize(items.filter((i) => i.changePct > 0)),
        lowers: summarize(items.filter((i) => i.changePct < 0)),
      };
    }, tenantId);
  }

  /** Estrategia de precios del tenant (objetivo, límites y posicionamiento). */
  async getPricingStrategy(tenantId: string): Promise<PricingStrategyDto> {
    return this.prisma.withTenant(async (tx) => {
      const [tenant, facilities, unitTypes] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            pricingTargetOccupancy: true,
            pricingMaxStepPct: true,
            pricingMinDaysBetweenChanges: true,
          },
        }),
        tx.facility.findMany({
          where: { deletedAt: null },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, pricingPositioningPct: true },
        }),
        tx.unitType.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, minPriceMonthly: true, maxPriceMonthly: true },
        }),
      ]);
      return {
        targetOccupancy: tenant?.pricingTargetOccupancy ?? 88,
        maxStepPct: tenant?.pricingMaxStepPct ?? 8,
        minDaysBetweenChanges: tenant?.pricingMinDaysBetweenChanges ?? 30,
        facilities: facilities.map((f) => ({
          id: f.id,
          name: f.name,
          positioningPct: f.pricingPositioningPct,
        })),
        unitTypes: unitTypes.map((t) => ({
          id: t.id,
          name: t.name,
          minPrice: t.minPriceMonthly != null ? toNumber(t.minPriceMonthly) : null,
          maxPrice: t.maxPriceMonthly != null ? toNumber(t.maxPriceMonthly) : null,
        })),
      };
    }, tenantId);
  }

  async updatePricingStrategy(args: {
    tenantId: string;
    userId: string;
    input: UpdatePricingStrategyInput;
    meta: RequestMeta;
  }): Promise<PricingStrategyDto> {
    const { input } = args;
    await this.prisma.withTenant(async (tx) => {
      if (
        input.targetOccupancy !== undefined ||
        input.maxStepPct !== undefined ||
        input.minDaysBetweenChanges !== undefined
      ) {
        await tx.tenant.update({
          where: { id: args.tenantId },
          data: {
            ...(input.targetOccupancy !== undefined
              ? { pricingTargetOccupancy: input.targetOccupancy }
              : {}),
            ...(input.maxStepPct !== undefined ? { pricingMaxStepPct: input.maxStepPct } : {}),
            ...(input.minDaysBetweenChanges !== undefined
              ? { pricingMinDaysBetweenChanges: input.minDaysBetweenChanges }
              : {}),
          },
        });
      }
      for (const f of input.facilities ?? []) {
        // updateMany: ignora ids que no son del tenant (RLS) sin lanzar.
        await tx.facility.updateMany({
          where: { id: f.id, deletedAt: null },
          data: { pricingPositioningPct: f.positioningPct },
        });
      }
      for (const t of input.unitTypes ?? []) {
        await tx.unitType.updateMany({
          where: { id: t.id },
          data: { minPriceMonthly: t.minPrice, maxPriceMonthly: t.maxPrice },
        });
      }
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'pricing.strategy_updated',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: input as unknown as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.getPricingStrategy(args.tenantId);
  }

  /** Aplica el precio sugerido a un trastero (fija `basePriceMonthly`). */
  async applyUnitPricing(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    price: number;
    meta: RequestMeta;
  }): Promise<ApplyUnitPricingResultDto> {
    const result = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({ where: { id: args.unitId } });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      const previousPrice = toNumber(unit.basePriceMonthly);
      const newPrice = round2(args.price);
      await tx.unit.update({ where: { id: args.unitId }, data: { basePriceMonthly: newPrice } });
      if (newPrice !== previousPrice) {
        await tx.unitPriceHistory.create({
          data: {
            tenantId: args.tenantId,
            unitId: args.unitId,
            previousPrice,
            newPrice,
            source: 'suggestion',
            changedByUserId: args.userId,
          },
        });
      }
      return { previousPrice, newPrice };
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'pricing.unit_suggestion_applied',
      entityType: 'Unit',
      entityId: args.unitId,
      changes: { from: result.previousPrice, to: result.newPrice },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return { unitId: args.unitId, previousPrice: result.previousPrice, newPrice: result.newPrice };
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
