import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { isFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { formatEur, todayInTimezone } from '../../common/format';
import { CHARGEABLE_MANDATE_WHERE } from '../../common/sepa-remittance-guard';
import { AuditService } from '../auth/audit.service';
import { overdueInvoiceWhere } from '../dashboard/today-filters';
import { PrismaService } from '../database/prisma.service';
import { toActiveUnitOffer } from '../promotions/promotions.service';

import {
  ALL_FACILITIES,
  contractLifecycle,
  contractWhere,
  LIFECYCLE_SELECT,
  LIVE_CONTRACT_WHERE,
  liveMrr,
  monthlyFee,
  MONTHLY_FEE_SELECT,
  SIGNED_CONTRACT_WHERE,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';
import {
  currentYearMonth,
  receivables,
  tenantTimezone,
  testRunUnits,
  unitCounts,
  zonedMonthStart,
} from './business-metrics';
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
  competitorComparablePrice,
  marketTrend,
  rentalIntervals,
  statusAt,
  featureMultiplier,
  freeSince,
  FRESHNESS_CUTOFF_DAYS,
  type MarketCurve,
} from './pricing-engine';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  ApplyPricingResultDto,
  ApplyUnitPricingManyResultDto,
  ApplyUnitPricingResultDto,
  ChurnRiskItemDto,
  CompetitionAlertsDto,
  CompetitionPriceDropDto,
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

/** Cobros fallidos y reclamaciones más antiguos no cuentan para el riesgo de baja. */
const RISK_LOOKBACK_DAYS = 365;
/** Dentro de este plazo un cobro fallido o una reclamación pesan entero. */
const RISK_RECENT_DAYS = 90;
/** Días sin entrar al local a partir de los que se avisa. */
const INACTIVE_ACCESS_DAYS = 90;
/** Un competidor sin revisar en más de estos días se avisa. */
const COMPETITOR_STALE_DAYS = 30;
/** Ventana de las bajadas de precio de la competencia que se avisan. */
const COMPETITOR_DROP_DAYS = 30;
/** Así empieza el motivo de un cobro registrado por error y deshecho. */
const UNDONE_PAYMENT_PREFIX = 'Registrado por error';

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
  async getChurnRisk(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
    customerId?: string,
  ): Promise<ChurnRiskKpiDto> {
    return this.prisma.withTenant(async (tx) => {
      const startOfToday = todayInTimezone(await tenantTimezone(tx, tenantId));
      const contracts = await tx.contract.findMany({
        where: {
          AND: [LIVE_CONTRACT_WHERE, contractWhere(scope), customerId ? { customerId } : {}],
        },
        select: {
          id: true,
          contractNumber: true,
          customerId: true,
          ...MONTHLY_FEE_SELECT,
          endDate: true,
          autoRenew: true,
          status: true,
          signedAt: true,
          customer: {
            select: {
              id: true,
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
              phone: true,
            },
          },
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
        orderBy: { priceMonthly: 'desc' },
      });

      if (contracts.length === 0) {
        return {
          summary: { high: 0, medium: 0, low: 0, total: 0, atStakeMonthly: 0 },
          items: [],
        };
      }

      const customerIds = [...new Set(contracts.map((c) => c.customerId))];

      // Los cobros fallidos y las reclamaciones solo cuentan si son del último año.
      const since = new Date(Date.now() - RISK_LOOKBACK_DAYS * 86_400_000);
      const [
        overdue,
        failedPayments,
        dunning,
        defaultPms,
        mandates,
        credentials,
        accesses,
        devices,
        autoCharge,
      ] = await Promise.all([
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { ...overdueInvoiceWhere(startOfToday), customerId: { in: customerIds } },
          _count: { _all: true },
          _sum: { total: true, amountPaid: true },
        }),
        tx.payment.findMany({
          where: {
            status: 'failed',
            customerId: { in: customerIds },
            createdAt: { gte: since },
            // Un cobro registrado por error y deshecho no es un cobro fallido.
            OR: [
              { failureReason: null },
              { NOT: { failureReason: { startsWith: UNDONE_PAYMENT_PREFIX } } },
            ],
          },
          select: { customerId: true, createdAt: true },
        }),
        tx.dunningAction.findMany({
          where: {
            status: 'executed',
            executedAt: { gte: since },
            invoice: { customerId: { in: customerIds } },
          },
          select: { executedAt: true, invoice: { select: { customerId: true } } },
        }),
        tx.paymentMethod.findMany({
          where: { customerId: { in: customerIds }, isDefault: true, deletedAt: null },
          select: { customerId: true },
        }),
        // Quien paga por la remesa SEPA del negocio también tiene cómo pagar.
        tx.sepaMandate.findMany({
          where: {
            customerId: { in: customerIds },
            ...CHARGEABLE_MANDATE_WHERE,
          },
          select: { customerId: true },
        }),
        // Quién tiene un código de acceso activo y cuándo entró por última vez.
        tx.accessCredential.findMany({
          where: { customerId: { in: customerIds }, status: 'active' },
          select: { customerId: true },
        }),
        tx.accessLog.groupBy({
          by: ['customerId'],
          where: { customerId: { in: customerIds }, result: 'allowed' },
          _max: { occurredAt: true },
        }),
        // Sin puertas conectadas no se sabe quién entra.
        tx.accessDevice.count({ where: { isActive: true } }),
        this.chargesAutomatically(tx),
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
      // Lo reciente pesa más: en los últimos 90 días cuenta entero, antes, la mitad.
      const recentCut = Date.now() - RISK_RECENT_DAYS * 86_400_000;
      const failedByCustomer = new Map<string, { count: number; recent: number }>();
      for (const p of failedPayments) {
        if (!p.customerId) continue;
        const cur = failedByCustomer.get(p.customerId) ?? { count: 0, recent: 0 };
        cur.count += 1;
        if (p.createdAt.getTime() >= recentCut) cur.recent += 1;
        failedByCustomer.set(p.customerId, cur);
      }
      const dunningByCustomer = new Map<string, { count: number; recent: number }>();
      for (const d of dunning) {
        const cid = d.invoice?.customerId;
        if (!cid) continue;
        const cur = dunningByCustomer.get(cid) ?? { count: 0, recent: 0 };
        cur.count += 1;
        if (d.executedAt && d.executedAt.getTime() >= recentCut) cur.recent += 1;
        dunningByCustomer.set(cid, cur);
      }
      const withCredential = new Set(credentials.map((c) => c.customerId));
      const lastAccess = new Map(
        accesses
          .filter((a) => a.customerId && a._max?.occurredAt)
          .map((a) => [a.customerId!, a._max!.occurredAt!]),
      );
      const customersWithPm = new Set([
        ...defaultPms.map((p) => p.customerId),
        ...mandates.map((m) => m.customerId),
      ]);

      // Un inquilino, una fila: sus contratos se miran juntos.
      const byCustomer = new Map<string, typeof contracts>();
      for (const c of contracts) {
        byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);
      }

      const now = Date.now();
      const items: ChurnRiskItemDto[] = [...byCustomer.entries()].map(([cid, list]) => {
        const main = list.find((c) => c.status === 'ending') ?? list[0]!;
        const price = round2(list.reduce((sum, c) => sum + monthlyFee(c), 0));
        const factors: string[] = [];
        let score = 0;

        const od = overdueByCustomer.get(cid);
        if (od && od.count > 0) {
          score += 35;
          factors.push(od.count === 1 ? '1 factura vencida' : `${od.count} facturas vencidas`);
          if (od.count >= 2) score += 10;
          if (price > 0 && od.pending > price) {
            score += 10;
            factors.push('debe más de una mensualidad');
          }
        }

        const failed = failedByCustomer.get(cid);
        if (failed) {
          score += failed.recent > 0 ? 20 : 10;
          const label = failed.count === 1 ? '1 cobro fallido' : `${failed.count} cobros fallidos`;
          factors.push(failed.recent > 0 ? `${label} (reciente)` : `${label} en el último año`);
        }

        const dun = dunningByCustomer.get(cid);
        if (dun) {
          score += dun.recent > 0 ? 15 : 8;
          factors.push(dun.recent > 0 ? 'reclamado hace poco' : 'reclamado en el último año');
        }

        // Quien no usa su trastero suele acabar dándose de baja (solo con puertas
        // conectadas: sin ellas no se sabe quién entra).
        const seen = lastAccess.get(cid) ?? null;
        const firstSigned = Math.min(...list.map((c) => c.signedAt?.getTime() ?? now));
        const signedLongAgo = now - firstSigned > INACTIVE_ACCESS_DAYS * 86_400_000;
        if (
          devices > 0 &&
          withCredential.has(cid) &&
          signedLongAgo &&
          (!seen || now - seen.getTime() > INACTIVE_ACCESS_DAYS * 86_400_000)
        ) {
          score += 10;
          factors.push(
            seen ? `no entra desde hace más de ${INACTIVE_ACCESS_DAYS} días` : 'nunca ha entrado',
          );
        }

        // El contrato que vence antes (sin renovación automática pesa más).
        const ending = list
          .filter((c) => c.endDate && c.endDate.getTime() >= startOfToday.getTime())
          .sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime())[0];
        if (ending?.endDate) {
          const daysToEnd = Math.ceil(
            (ending.endDate.getTime() - startOfToday.getTime()) / 86_400_000,
          );
          if (daysToEnd <= 60 && !ending.autoRenew) {
            score += 25;
            factors.push(`vence en ${daysToEnd} días sin renovación automática`);
          } else if (daysToEnd <= 30) {
            score += 10;
            factors.push(`vence en ${daysToEnd} días`);
          }
        }

        // Sin forma de cobrar sola en el negocio, no tener tarjeta no dice nada.
        if (autoCharge && !customersWithPm.has(cid)) {
          score += 15;
          factors.push('sin método de pago guardado');
        }

        score = Math.min(100, score);
        const facilities = [...new Set(list.map((c) => c.unit.facility.name))];

        return {
          contractId: main.id,
          contractNumber: main.contractNumber,
          customerId: cid,
          customerName: customerName(main.customer),
          unitCode: list.map((c) => c.unit.code).join(', '),
          facilityName: facilities.join(', '),
          priceMonthly: price,
          contractCount: list.length,
          score,
          level: levelFor(score),
          factors,
          contractStatus: main.status === 'ending' ? 'ending' : 'active',
          lastAccessAt: seen ? seen.toISOString() : null,
          phone: main.customer.phone,
        };
      });

      const summary = {
        high: items.filter((i) => i.level === 'high').length,
        medium: items.filter((i) => i.level === 'medium').length,
        low: items.filter((i) => i.level === 'low').length,
        total: items.length,
        // Lo que se pierde al mes si se van los de riesgo alto y medio.
        atStakeMonthly: round2(
          items.filter((i) => i.level !== 'low').reduce((sum, i) => sum + (i.priceMonthly ?? 0), 0),
        ),
      };

      // El detalle omite los `low` (sin señales relevantes) y ordena por riesgo.
      const detail = items
        .filter((i) => i.level !== 'low')
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);

      return { summary, items: detail };
    }, tenantId);
  }

  /** ¿Puede el negocio cobrar solo (tarjeta guardada, domiciliación o SEPA)? */
  private async chargesAutomatically(tx: Prisma.TransactionClient): Promise<boolean> {
    const [stripe, redsys, sepa, gocardless] = await Promise.all([
      tx.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
      tx.redsysSettings.count({ where: { enabled: true, cardOnFileEnabled: true } }),
      tx.sepaSettings.count({ where: { enabled: true } }),
      tx.goCardlessSettings.count({ where: { enabled: true } }),
    ]);
    return stripe + redsys + sepa + gocardless > 0;
  }

  /**
   * «Sugerencias de hoy»: acciones concretas priorizadas cruzando las señales que
   * ya calcula el sistema (riesgo de baja, precio por debajo de mercado, facturas
   * vencidas, contratos que vencen sin renovación). Determinista (no depende de la
   * IA) → funciona en cualquier entorno; cada acción enlaza al recurso exacto.
   */
  /**
   * Competencia que conviene mirar: fichas sin revisar en más de 30 días y
   * bajadas de precio recientes en tamaños donde tus trasteros son más caros.
   */
  async getCompetitionAlerts(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<CompetitionAlertsDto> {
    return this.prisma.withTenant(async (tx) => {
      const now = Date.now();
      const since = new Date(now - COMPETITOR_DROP_DAYS * 86_400_000);
      // Competidores ligados a un local que el usuario no ve quedan fuera.
      // Con un local elegido, sus competidores y los que no van ligados a
      // ninguno (lo mismo que enseña Competencia).
      const competitorScope: Prisma.CompetitorFacilityWhereInput = scope.ids
        ? { OR: [{ facilityId: { in: scope.ids } }, { facilityId: null }] }
        : {};
      const [competitors, myUnits] = await Promise.all([
        tx.competitorFacility.findMany({
          where: competitorScope,
          select: {
            id: true,
            name: true,
            facilityId: true,
            lastReviewedAt: true,
            priceIncludesVat: true,
            mandatoryInsuranceMonthly: true,
            setupFee: true,
            promoFreeMonths: true,
            promoDiscountPct: true,
            promoDiscountMonths: true,
            promoEndsAt: true,
            reviewEveryDays: true,
            inventoryComplete: true,
            units: {
              select: {
                id: true,
                areaM2: true,
                status: true,
                lastCheckedAt: true,
                // Las dos últimas revisiones: la de ahora y la anterior, sea cuando sea.
                observations: {
                  orderBy: { observedAt: 'desc' },
                  take: 2,
                  select: { priceMonthly: true, observedAt: true },
                },
              },
            },
          },
          orderBy: { name: 'asc' },
        }),
        tx.unit.findMany({
          where: { ...unitWhere(scope), status: { in: ['available', 'reserved', 'occupied'] } },
          select: {
            facilityId: true,
            areaM2: true,
            basePriceMonthly: true,
            status: true,
            unitTypeId: true,
            unitType: { select: { name: true } },
          },
        }),
      ]);

      // La última comprobación es la revisión completa o la de cualquier
      // trastero (alta, cambio o «comprobado hoy»). Sin trasteros no avisa:
      // no hay precios que se queden viejos.
      const stale = competitors
        .filter((c) => c.units.length > 0)
        .map((c) => {
          let checked = c.lastReviewedAt;
          for (const u of c.units) {
            const at = u.observations[0]?.observedAt;
            if (at && (!checked || at > checked)) checked = at;
          }
          return { c, checked };
        })
        // Cada competidor con su plazo de revisión (30 días si no tiene).
        .filter(({ c, checked }) => {
          if (!checked) return true;
          const days = c.reviewEveryDays ?? COMPETITOR_STALE_DAYS;
          return checked.getTime() < now - days * 86_400_000;
        })
        .map(({ c, checked }) => ({
          id: c.id,
          name: c.name,
          lastReviewedAt: checked ? checked.toISOString() : null,
        }));

      const myPriceFor = (area: number, facilityId: string | null): number | null => {
        const near = myUnits.filter(
          (u) =>
            (!facilityId || u.facilityId === facilityId) &&
            toNumber(u.areaM2) >= area * 0.75 &&
            toNumber(u.areaM2) <= area * 1.25,
        );
        if (near.length === 0) return null;
        return round2(near.reduce((sum, u) => sum + toNumber(u.basePriceMonthly), 0) / near.length);
      };

      const priceDrops: CompetitionPriceDropDto[] = [];
      const priceRises: CompetitionPriceDropDto[] = [];
      for (const c of competitors) {
        // Su precio comparable con el tuyo: sin IVA, con seguro, alta y promoción.
        const comparable = (price: number) => round2(competitorComparablePrice(c, price));
        for (const u of c.units) {
          const [latest, previous] = u.observations;
          // Solo una bajada reciente que sigue vigente (la última revisión).
          if (!latest || !previous || latest.observedAt < since) continue;
          const prev = toNumber(previous.priceMonthly);
          const next = toNumber(latest.priceMonthly);
          if (next === prev) continue;
          const area = toNumber(u.areaM2);
          const mine = myPriceFor(area, c.facilityId);
          const comparablePrice = comparable(next);
          // Sube y tú eres más barato: tienes margen para subir.
          if (next > prev) {
            if (mine !== null && mine < comparablePrice) {
              priceRises.push({
                competitorFacilityId: c.id,
                competitorName: c.name,
                competitorUnitId: u.id,
                areaM2: area,
                previousPrice: prev,
                newPrice: next,
                comparablePrice,
                observedAt: latest.observedAt.toISOString(),
                myPrice: mine,
              });
            }
            continue;
          }
          if (mine !== null && mine > comparablePrice) {
            priceDrops.push({
              competitorFacilityId: c.id,
              competitorName: c.name,
              competitorUnitId: u.id,
              areaM2: area,
              previousPrice: prev,
              newPrice: next,
              comparablePrice,
              observedAt: latest.observedAt.toISOString(),
              myPrice: mine,
            });
          }
        }
      }
      priceDrops.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      priceRises.sort((a, b) => b.observedAt.localeCompare(a.observedAt));

      // Se les agota un tamaño que tú tienes libre: es tu momento para ese tamaño.
      const freshCut = now - 30 * 86_400_000;
      const myTypes = new Map<
        string,
        { name: string; areas: number[]; available: number; facilities: Set<string> }
      >();
      for (const u of myUnits) {
        const t = myTypes.get(u.unitTypeId) ?? {
          name: u.unitType.name,
          areas: [],
          available: 0,
          facilities: new Set<string>(),
        };
        t.areas.push(toNumber(u.areaM2));
        if (u.status === 'available') t.available += 1;
        t.facilities.add(u.facilityId);
        myTypes.set(u.unitTypeId, t);
      }
      const soldOut: CompetitionAlertsDto['soldOut'] = [];
      for (const c of competitors) {
        if (!c.inventoryComplete || c.units.length === 0) continue;
        // Su inventario tiene que estar al día (revisado este mes).
        if (c.units.some((u) => u.lastCheckedAt.getTime() < freshCut)) continue;
        for (const t of myTypes.values()) {
          if (t.available === 0) continue;
          if (c.facilityId && !t.facilities.has(c.facilityId)) continue;
          const areas = t.areas.filter((a) => a > 0);
          if (areas.length === 0) continue;
          const area = areas.reduce((x, y) => x + y, 0) / areas.length;
          const near = c.units.filter((u) => {
            const a = toNumber(u.areaM2);
            return a >= area * 0.75 && a <= area * 1.25;
          });
          if (near.length === 0 || near.some((u) => u.status === 'available')) continue;
          soldOut.push({
            competitorFacilityId: c.id,
            competitorName: c.name,
            unitTypeName: t.name,
            areaM2: round2(area),
            myAvailable: t.available,
          });
        }
      }
      return { stale, priceDrops, priceRises, soldOut };
    }, tenantId);
  }

  async getSuggestedActions(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
    opts: { moneyVisible?: boolean } = {},
  ): Promise<SuggestedActionsDto> {
    const moneyVisible = opts.moneyVisible ?? true;
    const [churn, pricing, competition, extra] = await Promise.all([
      this.getChurnRisk(tenantId, scope),
      this.getUnitPricingSuggestions(tenantId, scope),
      this.getCompetitionAlerts(tenantId, scope),
      this.prisma.withTenant(async (tx) => {
        const startOfToday = todayInTimezone(await tenantTimezone(tx, tenantId));
        // Desde hoy (también lo que vence hoy) hasta dentro de 30 días.
        const in30 = new Date(startOfToday.getTime() + 30 * 24 * 3600 * 1000);
        const [debt, endingSoon] = await Promise.all([
          receivables(tx, scope, startOfToday),
          tx.contract.findMany({
            where: {
              AND: [
                LIVE_CONTRACT_WHERE,
                contractWhere(scope),
                { autoRenew: false, endDate: { not: null, gte: startOfToday, lte: in30 } },
              ],
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
        return { debt, endingSoon };
      }, tenantId),
    ]);

    const actions: SuggestedActionDto[] = [];

    // 1) Cobros: facturas vencidas por reclamar.
    const overdueCount = extra.debt.overdueInvoices;
    if (overdueCount > 0) {
      const pending = extra.debt.overdue;
      actions.push({
        id: 'collections',
        category: 'collections',
        priority: pending >= 300 || overdueCount >= 3 ? 'high' : 'medium',
        title: `Reclama ${overdueCount} factura${overdueCount === 1 ? '' : 's'} vencida${
          overdueCount === 1 ? '' : 's'
        }`,
        detail: moneyVisible
          ? `${formatEur(pending)} pendientes de cobro`
          : 'Revisa quién debe y desde cuándo',
        href: '/arrears',
        cta: 'Ver deudores',
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
        detail: `Sugerido ${formatEur(u.suggestedPrice)} (+${u.changePct}% vs ${formatEur(u.currentPrice)})`,
        href: '/analytics?tab=pricing',
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

    // 5) Competencia: bajadas de precio donde eres más caro y fichas sin revisar.
    const drop = competition.priceDrops[0];
    if (drop) {
      actions.push({
        id: `competition-drop-${drop.competitorUnitId}`,
        category: 'competition',
        priority: 'medium',
        title: `${drop.competitorName} ha bajado precios`,
        detail: `${drop.areaM2} m² a ${formatEur(drop.newPrice)} (antes ${formatEur(drop.previousPrice)}); equivale a ${formatEur(drop.comparablePrice)} sin IVA y tú cobras ${formatEur(drop.myPrice)}`,
        href: '/competitors',
        cta: 'Ver competencia',
      });
    }
    if (competition.stale.length > 0) {
      const n = competition.stale.length;
      actions.push({
        id: 'competition-stale',
        category: 'competition',
        priority: 'medium',
        title: `Revisa ${n} competidor${n === 1 ? '' : 'es'}`,
        detail: `Sin revisar en más de ${COMPETITOR_STALE_DAYS} días: los precios de mercado pierden fiabilidad`,
        href: '/competitors',
        cta: 'Revisar',
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
          preOpening: true,
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
          promoEndsAt: true,
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
      // Los que se pueden alquilar: los que están en mantenimiento o bloqueados no.
      tx.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { status: { in: ['available', 'reserved', 'occupied'] } },
        _count: { _all: true },
      }),
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
      // Mis alquileres de los últimos 90 días (de verdad: sin el inquilino de
      // prueba, reservas online sin pagar ni preventas sin empezar), por tamaño.
      tx.contract.findMany({
        where: { AND: [SIGNED_CONTRACT_WHERE, { signedAt: { gte: since90 } }] },
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
    // Los trasteros del inquilino de prueba siguen libres para las cifras.
    const testUnits = await testRunUnits(tx, {});
    const testTypes = new Map(
      (
        await tx.unit.findMany({
          where: { id: { in: testUnits.map((u) => u.id) } },
          select: { id: true, unitTypeId: true },
        })
      ).map((u) => [u.id, u.unitTypeId]),
    );
    for (const u of testUnits) {
      if (u.status !== 'occupied' && u.status !== 'reserved') continue;
      const k = key(u.facilityId, testTypes.get(u.id) ?? '');
      const n = occMap.get(k);
      if (n) occMap.set(k, n - 1);
    }
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
        return {
          areaM2: toNumber(u.areaM2),
          // Una promoción que ya terminó no cuenta.
          price: competitorComparablePrice(c, toNumber(u.priceMonthly), now),
          occupied: u.status === 'occupied',
          ageDays: daysBetween(u.lastCheckedAt, now),
          // Lo revisado hace más de 180 días ya no dice nada de su ocupación ni su ritmo.
          fresh: daysBetween(u.lastCheckedAt, now) <= FRESHNESS_CUTOFF_DAYS,
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
          if (!u.fresh || Math.abs(u.areaM2 - areaM2) > areaM2 * 0.25) continue;
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
          if (!u.fresh || Math.abs(u.areaM2 - areaM2) > areaM2 * 0.25) continue;
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
  async getPricingSuggestions(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<PricingSuggestionsDto> {
    return this.prisma.withTenant(async (tx) => {
      const ctx = await this.loadPricingContext(tx, tenantId);
      // Los locales por abrir no cuentan hasta que abren (salvo si se mira ese local).
      const facilitiesInScope = (
        scope.ids ? ctx.facilities.filter((f) => scope.ids!.includes(f.id)) : ctx.facilities
      ).filter((f) => scope.explicit || !f.preOpening);
      const inScopeIds = facilitiesInScope.map((f) => f.id);
      const [areas, freeAll, lastChanges] = await Promise.all([
        tx.unit.groupBy({
          by: ['unitTypeId'],
          where: { ...unitWhere(scope), facilityId: { in: inScopeIds } },
          _avg: { areaM2: true },
        }),
        // Aplicar cambia el precio de los libres del tipo en todos los locales.
        tx.unit.groupBy({
          by: ['unitTypeId'],
          where: { status: 'available', facility: { deletedAt: null } },
          _count: { _all: true },
        }),
        // Último cambio de precio de un trastero de cada tipo (espera entre cambios).
        tx.unitPriceHistory.findMany({
          where: { unit: { facilityId: { in: inScopeIds } } },
          orderBy: { changedAt: 'desc' },
          distinct: ['unitId'],
          select: { changedAt: true, unit: { select: { unitTypeId: true } } },
        }),
      ]);
      const avgArea = new Map(areas.map((a) => [a.unitTypeId, toNumber(a._avg.areaM2)]));
      const freeAllByType = new Map(freeAll.map((g) => [g.unitTypeId, g._count._all]));
      const lastChangeByType = new Map<string, Date>();
      for (const c of lastChanges) {
        const seen = lastChangeByType.get(c.unit.unitTypeId);
        if (!seen || c.changedAt > seen) lastChangeByType.set(c.unit.unitTypeId, c.changedAt);
      }
      // Con un solo local elegido, su mercado y sus contactos.
      const only = scope.explicit && facilitiesInScope.length === 1 ? facilitiesInScope[0]! : null;
      const curve = ctx.marketCurve(only);

      const items: PricingSuggestionItemDto[] = [];
      for (const ut of ctx.unitTypes) {
        // Agrega el tipo en todos los locales.
        let total = 0;
        let occupied = 0;
        let waiting = 0;
        let free = 0;
        let rentals90 = 0;
        let positioningWeighted = 0;
        for (const f of facilitiesInScope) {
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
          competitorOccupancy: area > 0 ? ctx.competitorOccupancy(only, area) : null,
          competitorDaysToRent: area > 0 ? ctx.competitorDaysToRent(only, area) : null,
          ownRentals: { rentals90, available: free },
          leads: ctx.leadsFor(only?.id ?? null, ut.id),
        });
        const changedAt = lastChangeByType.get(ut.id);
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
          daysSinceLastChange: changedAt ? daysBetween(changedAt, ctx.now) : null,
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
          marketTrend: ctx.marketTrendFor(only),
          availableUnitsAll: freeAllByType.get(ut.id) ?? 0,
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
    scope: AnalyticsScope = ALL_FACILITIES,
    includeCompetition = true,
  ): Promise<UnitPricingSuggestionsDto> {
    return this.prisma.withTenant(async (tx) => {
      const units = await tx.unit.findMany({
        where: { status: 'available', ...unitWhere(scope) },
        include: {
          unitType: { select: { id: true, name: true } },
          facility: { select: { name: true } },
        },
      });
      if (units.length === 0) return { items: [] };

      const ctx = await this.loadPricingContext(tx, tenantId);
      const unitIds = units.map((u) => u.id);
      const [history, lastChanges, promos] = await Promise.all([
        // Días libre: desde que dejó de estar ocupado (una reserva que caduca no
        // reinicia la cuenta).
        tx.unitStatusHistory.findMany({
          where: { unitId: { in: unitIds } },
          select: { unitId: true, occurredAt: true, newStatus: true },
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
      const historyByUnit = new Map<string, { occurredAt: Date; newStatus: string }[]>();
      for (const h of history) {
        historyByUnit.set(h.unitId, [...(historyByUnit.get(h.unitId) ?? []), h]);
      }
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
          preOpening: false,
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

        const since = freeSince(u.createdAt, historyByUnit.get(u.id) ?? []);
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
  async getPriceChangeEffects(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<PriceChangeEffectsDto> {
    return this.prisma.withTenant(async (tx) => {
      const now = new Date();
      const changes = await tx.unitPriceHistory.findMany({
        where: {
          changedAt: { gte: new Date(now.getTime() - 365 * 86_400_000) },
          ...(scope.ids ? { unit: { facilityId: { in: scope.ids } } } : {}),
        },
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
  async getPricingStrategy(
    tenantId: string,
    facilityScope: FacilityScope = null,
  ): Promise<PricingStrategyDto> {
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
          where: { deletedAt: null, ...(facilityScope ? { id: { in: facilityScope } } : {}) },
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
    facilityScope?: FacilityScope;
  }): Promise<PricingStrategyDto> {
    const { input } = args;
    // La estrategia es de toda la empresa (objetivo, límites de cada tipo).
    if (args.facilityScope) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message:
          'La estrategia de precios es de toda la empresa: pídeselo a quien ve todos los locales',
      });
    }
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

  /**
   * Aplica de una vez el precio de varios trasteros. Cada uno va por separado:
   * si uno falla (no existe o es de un local que no ves), el resto sigue.
   */
  async applyUnitPricingMany(args: {
    tenantId: string;
    userId: string;
    items: { unitId: string; price: number }[];
    meta: RequestMeta;
    facilityScope?: FacilityScope;
  }): Promise<ApplyUnitPricingManyResultDto> {
    let applied = 0;
    const failed: ApplyUnitPricingManyResultDto['failed'] = [];
    for (const item of args.items) {
      try {
        await this.applyUnitPricing({
          tenantId: args.tenantId,
          userId: args.userId,
          unitId: item.unitId,
          price: item.price,
          meta: args.meta,
          ...(args.facilityScope !== undefined ? { facilityScope: args.facilityScope } : {}),
        });
        applied += 1;
      } catch (err) {
        failed.push({
          unitId: item.unitId,
          message:
            err instanceof NotFoundException ? 'Trastero no encontrado' : 'No se pudo aplicar',
        });
      }
    }
    return { applied, failed };
  }

  /** Aplica el precio sugerido a un trastero (fija `basePriceMonthly`). */
  async applyUnitPricing(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    price: number;
    meta: RequestMeta;
    facilityScope?: FacilityScope;
  }): Promise<ApplyUnitPricingResultDto> {
    const result = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({ where: { id: args.unitId } });
      // Un trastero de un local que el usuario no ve se trata como inexistente.
      if (!unit || !isFacilityAllowed(args.facilityScope, unit.facilityId)) {
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
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<RevenueForecastDto> {
    const horizon = Math.min(24, Math.max(1, opts.months ?? 6));
    const trailing = Math.min(24, Math.max(1, opts.trailingMonths ?? 6));

    return this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const [counts, live, contracts] = await Promise.all([
        unitCounts(tx, scope),
        liveMrr(tx, scope),
        tx.contract.findMany({
          where: { AND: [SIGNED_CONTRACT_WHERE, contractWhere(scope)] },
          select: LIFECYCLE_SELECT,
        }),
      ]);
      // El tope son los trasteros que se pueden alquilar (sin los que están en
      // mantenimiento o bloqueados).
      const capacity = counts.total - counts.outOfService;
      const history = contracts
        .map((c) => contractLifecycle(c))
        .filter((l): l is NonNullable<typeof l> => l !== null);

      const mrr = live.mrr;
      const activeCount = live.contracts;
      const avgContractValue = activeCount > 0 ? mrr / activeCount : 0;
      const currentOccupancy = capacity > 0 ? round2(counts.occupied / capacity) : 0;

      // Medias de los meses cerrados (sin el mes en curso), y solo de los que el
      // negocio ya existía: un negocio de dos meses no reparte sus altas entre seis.
      const { year, month } = currentYearMonth(timezone);
      const firstBegin = history.reduce<number | null>(
        (min, c) => (min === null || c.begin.getTime() < min ? c.begin.getTime() : min),
        null,
      );
      let churnRateSum = 0;
      let churnRateCount = 0;
      let addsSum = 0;
      let monthsWithHistory = 0;
      for (let i = 1; i <= trailing; i++) {
        const startMs = zonedMonthStart(year, month - i, timezone).getTime();
        const endMs = zonedMonthStart(year, month - i + 1, timezone).getTime();
        if (firstBegin === null || endMs <= firstBegin) continue;
        monthsWithHistory += 1;

        let activeAtStart = 0;
        let started = 0;
        let ended = 0;
        for (const c of history) {
          const begin = c.begin.getTime();
          const endedAt = c.end?.getTime() ?? null;
          if (begin < startMs && (endedAt === null || endedAt >= startMs)) activeAtStart += 1;
          if (begin >= startMs && begin < endMs) started += 1;
          // Como en Analítica → Bajas: también quien entra y se va el mismo mes.
          if (endedAt !== null && endedAt >= startMs && endedAt < endMs) ended += 1;
        }
        const base = activeAtStart + started;
        if (base > 0) {
          churnRateSum += ended / base;
          churnRateCount += 1;
        }
        addsSum += started;
      }
      // Sin redondear: con tasas pequeñas, redondear a dos decimales las borraba.
      const churnRate = churnRateCount > 0 ? churnRateSum / churnRateCount : 0;
      const adds = monthsWithHistory > 0 ? addsSum / monthsWithHistory : 0;

      // Proyección mes a mes sin redondear entre meses (si no, 23,5 contratos
      // volvían a 24 cada mes y la previsión se quedaba plana).
      const points: RevenueForecastPointDto[] = [];
      let prevActive = activeCount;
      let cappedAtCapacity = false;
      for (let m = 1; m <= horizon; m++) {
        const trend = prevActive - prevActive * churnRate + adds;
        if (trend > capacity) cappedAtCapacity = true;
        const projected = Math.max(0, Math.min(trend, capacity));
        const monthDate = new Date(Date.UTC(year, month - 1 + m, 1));
        const yearMonth = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}`;
        points.push({
          yearMonth,
          projectedActiveContracts: Math.round(projected),
          projectedMrr: round2(projected * avgContractValue),
          projectedOccupancy: capacity > 0 ? round2(Math.min(1, projected / capacity)) : 0,
        });
        prevActive = projected;
      }

      return {
        current: {
          activeContracts: activeCount,
          mrr,
          totalUnits: capacity,
          occupancy: currentOccupancy,
        },
        assumptions: {
          monthlyChurnRate: Math.round(churnRate * 10_000) / 10_000,
          avgMonthlyNewContracts: round2(adds),
          avgContractValue: round2(avgContractValue),
          trailingMonths: trailing,
          historyMonths: monthsWithHistory,
          cappedAtCapacity,
        },
        points,
      };
    }, tenantId);
  }

  /**
   * Aplica el precio sugerido a un tipo de trastero: su precio de catálogo y el
   * de los trasteros libres de ese tipo en todos los locales (es el precio al
   * que se venden). No toca los contratos activos — para subir la cartera
   * existe ECRI (rent-increases).
   */
  async applyPricing(args: {
    tenantId: string;
    userId: string;
    unitTypeId: string;
    price: number;
    meta: RequestMeta;
    facilityScope?: FacilityScope;
  }): Promise<ApplyPricingResultDto> {
    // El precio de catálogo de un tipo vale para todos los locales.
    if (args.facilityScope) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message:
          'El precio de un tipo de trastero afecta a todos los locales: pídeselo a quien los ve todos',
      });
    }
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
      const free = await tx.unit.findMany({
        where: {
          unitTypeId: args.unitTypeId,
          status: 'available',
          facility: { deletedAt: null },
          NOT: { basePriceMonthly: newPrice },
        },
        select: { id: true, basePriceMonthly: true },
      });
      if (free.length > 0) {
        await tx.unit.updateMany({
          where: { id: { in: free.map((u) => u.id) } },
          data: { basePriceMonthly: newPrice },
        });
        await tx.unitPriceHistory.createMany({
          data: free.map((u) => ({
            tenantId: args.tenantId,
            unitId: u.id,
            previousPrice: u.basePriceMonthly,
            newPrice,
            source: 'suggestion' as const,
            changedByUserId: args.userId,
          })),
        });
      }
      return { previousPrice, newPrice, unitsUpdated: free.length };
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'pricing.suggestion_applied',
      entityType: 'UnitType',
      entityId: args.unitTypeId,
      changes: {
        from: result.previousPrice,
        to: result.newPrice,
        unitsUpdated: result.unitsUpdated,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      unitTypeId: args.unitTypeId,
      previousPrice: result.previousPrice,
      newPrice: result.newPrice,
      unitsUpdated: result.unitsUpdated,
    };
  }
}
