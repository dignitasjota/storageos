import { Injectable } from '@nestjs/common';
import { REVIEW_EXIT_REASONS, REVIEW_EXIT_REASON_LABELS } from '@storageos/shared';

import { todayInTimezone } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import {
  ALL_FACILITIES,
  contractLifecycle,
  contractWhere,
  invalidDate,
  invoiceWhere,
  LIFECYCLE_SELECT,
  monthlyFee,
  SIGNED_CONTRACT_WHERE,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';
import {
  INVOICED_SELECT,
  INVOICED_STATUSES,
  invoicedAmount,
  tenantTimezone,
  zonedMonthKey,
  zonedMonthStart,
} from './business-metrics';

import type {
  CohortRowDto,
  CohortsDto,
  ExitReasonsDto,
  OccupancyHistoryDto,
  PreOpeningAnalyticsDto,
  RevenueBreakdownDto,
  RevenueBreakdownRowDto,
  RevenueConcept,
} from '@storageos/shared';

const MONTHS_MAX = 36;
const DAY = 86_400_000;

const CONCEPT_LABELS: Record<RevenueConcept, string> = {
  rent: 'Alquiler',
  insurance: 'Seguro / protección',
  late_fee: 'Recargos por mora',
  shop: 'Tienda',
  night_pass: 'Pases nocturnos',
  other: 'Otros',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthKey(idx: number): string {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Último día del mes del índice (año × 12 + mes 0-11), como medianoche UTC. */
function lastDayOf(idx: number): Date {
  return new Date(Date.UTC(Math.floor((idx + 1) / 12), (idx + 1) % 12, 0));
}

/** Índice de mes (año × 12 + mes 0-11) de un instante en la zona del negocio. */
function monthIdx(date: Date, timezone: string): number {
  const [y, m] = zonedMonthKey(date, timezone).split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
}

/** Medianoche UTC del día de un instante en la zona del negocio. */
function dayOf(date: Date, timezone: string): number {
  return todayInTimezone(timezone, date).getTime();
}

/** Como mucho tres años de desglose (y las fechas, en orden). */
const BREAKDOWN_MAX_DAYS = 3 * 366;

function clampMonths(months?: number): number {
  return Math.max(1, Math.min(MONTHS_MAX, Math.floor(months ?? 12) || 12));
}

/** `YYYY-MM` a índice de mes; null si no viene. */
function parseMonth(value: string | undefined, field: string): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  const month = m ? Number(m[2]) : NaN;
  if (!m || month < 1 || month > 12) throw invalidDate(field, value);
  return Number(m[1]) * 12 + (month - 1);
}

function parseDay(value: string, field: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCDate() !== Number(m[3])) throw invalidDate(field, value);
  return d;
}

/** Concepto de una línea de factura. */
function conceptOf(
  description: string,
  invoice: { lateFeeForInvoiceId: string | null; contractId: string | null; saleId: string | null },
): RevenueConcept | null {
  if (invoice.lateFeeForInvoiceId) return 'late_fee';
  if (/^fianza/i.test(description)) return null;
  if (invoice.saleId) return 'shop';
  if (/pase nocturno/i.test(description)) return 'night_pass';
  if (/protecci|seguro/i.test(description)) return 'insurance';
  // Lo que se cobra por un recibo devuelto no es alquiler, aunque lleve el contrato.
  if (/recibo devuelto|tarjeta rechazada/i.test(description)) return 'other';
  if (invoice.contractId) return 'rent';
  return 'other';
}

/** Lo que hace falta de una factura para repartir sus líneas. */
const BREAKDOWN_INVOICE_SELECT = {
  id: true,
  contractId: true,
  lateFeeForInvoiceId: true,
  facility: { select: { id: true, name: true } },
  productSale: { select: { id: true, facility: { select: { id: true, name: true } } } },
  contract: {
    select: {
      unit: {
        select: {
          facility: { select: { id: true, name: true } },
          unitType: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

/**
 * Tendencias de Analítica: cómo evoluciona la ocupación, de dónde sale lo
 * facturado y cuánto duran los contratos según el mes en que empezaron.
 */
@Injectable()
export class AnalyticsTrendsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ocupación al final de cada mes, a partir de los contratos (lo que dura
   * cada uno) y de los trasteros que ya existían ese mes. El mes en curso, hoy.
   */
  async getOccupancyHistory(
    tenantId: string,
    months?: number,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<OccupancyHistoryDto> {
    const count = clampMonths(months);

    const { units, tenancies, timezone } = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const [units, tenancies] = await Promise.all([
        tx.unit.findMany({
          where: unitWhere(scope),
          select: {
            id: true,
            createdAt: true,
            facilityId: true,
            unitTypeId: true,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
          },
        }),
        // Quién tuvo cada trastero y cuándo: un traslado no mueve la historia.
        tx.unitTenancy.findMany({
          where: { unit: unitWhere(scope), contract: SIGNED_CONTRACT_WHERE },
          select: {
            unitId: true,
            startedOn: true,
            endedOn: true,
            priceMonthly: true,
            contract: {
              select: {
                discountAmount: true,
                billingIntervalMonths: true,
                prepayDiscountPct: true,
              },
            },
          },
        }),
      ]);
      return { units, tenancies, timezone };
    }, tenantId);

    const today = todayInTimezone(timezone);
    const curIdx = today.getUTCFullYear() * 12 + today.getUTCMonth();
    const idxs = Array.from({ length: count }, (_, i) => curIdx - (count - 1) + i);

    // Un trastero existe desde que se dio de alta o desde el primer inquilino de
    // los que se dieron de alta con él ese mismo día, si es anterior: al importar
    // una cartera todos nacen el día de la importación (también los libres) y
    // sus contratos tienen la fecha original.
    const firstTenancy = new Map<string, number>();
    for (const t of tenancies) {
      const at = t.startedOn.getTime();
      const seen = firstTenancy.get(t.unitId);
      if (seen === undefined || at < seen) firstTenancy.set(t.unitId, at);
    }
    const batchStart = new Map<number, number>();
    for (const u of units) {
      const day = dayOf(u.createdAt, timezone);
      const first = firstTenancy.get(u.id);
      if (first === undefined) continue;
      batchStart.set(day, Math.min(batchStart.get(day) ?? Infinity, first));
    }
    const bornOn = new Map(
      units.map((u) => {
        const day = dayOf(u.createdAt, timezone);
        return [u.id, Math.min(day, batchStart.get(day) ?? Infinity)];
      }),
    );

    /** Foto de un día: trasteros que existían, los alquilados y sus cuotas. */
    const snapshot = (idx: number) => {
      const day = (idx === curIdx ? today : lastDayOf(idx)).getTime();
      const existing = units.filter((u) => (bornOn.get(u.id) ?? Infinity) <= day);
      const occupied = new Set<string>();
      let mrr = 0;
      for (const t of tenancies) {
        if (t.startedOn.getTime() > day) continue;
        if (t.endedOn && t.endedOn.getTime() <= day) continue;
        if (occupied.has(t.unitId)) continue;
        occupied.add(t.unitId);
        mrr += monthlyFee({ ...t.contract, priceMonthly: t.priceMonthly });
      }
      return { idx, existing, occupied, mrr };
    };
    const toPoint = (s: ReturnType<typeof snapshot>) => {
      const occ = s.existing.filter((u) => s.occupied.has(u.id)).length;
      return {
        yearMonth: monthKey(s.idx),
        totalUnits: s.existing.length,
        occupiedUnits: occ,
        occupancy: s.existing.length === 0 ? 0 : occ / s.existing.length,
        mrr: round2(s.mrr),
      };
    };

    const snapshots = idxs.map(snapshot);
    const yearAgo = toPoint(snapshot(curIdx - 12));

    const series = (keyOf: (u: (typeof units)[number]) => [string, string]) => {
      const groups = new Map<string, string>();
      for (const u of units) {
        const [id, name] = keyOf(u);
        groups.set(id, name);
      }
      return [...groups.entries()]
        .map(([id, name]) => ({
          id,
          name,
          occupancy: snapshots.map((s) => {
            const inGroup = s.existing.filter((u) => keyOf(u)[0] === id);
            if (inGroup.length === 0) return 0;
            return inGroup.filter((u) => s.occupied.has(u.id)).length / inGroup.length;
          }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    };

    return {
      points: snapshots.map(toPoint),
      yearAgo: yearAgo.totalUnits > 0 ? yearAgo : null,
      byFacility: series((u) => [u.facilityId, u.facility.name]),
      byUnitType: series((u) => [u.unitTypeId, u.unitType.name]),
    };
  }

  /** De dónde sale lo facturado (base sin IVA) en un periodo. */
  async getRevenueBreakdown(
    tenantId: string,
    range: { from?: string; to?: string } = {},
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<RevenueBreakdownDto> {
    const { lines, from, to } = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const today = todayInTimezone(timezone);
      const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
      let from = range.from ? parseDay(range.from, 'from') : defaultFrom;
      let to = range.to ? parseDay(range.to, 'to') : today;
      if (from > to) [from, to] = [to, from];
      if ((to.getTime() - from.getTime()) / DAY > BREAKDOWN_MAX_DAYS) {
        from = new Date(to.getTime() - BREAKDOWN_MAX_DAYS * DAY);
      }
      const lines = await tx.invoiceItem.findMany({
        where: {
          invoice: {
            kind: 'invoice',
            deletedAt: null,
            status: { in: [...INVOICED_STATUSES] },
            issueDate: { gte: from, lt: new Date(to.getTime() + DAY) },
            ...invoiceWhere(scope),
          },
        },
        select: {
          description: true,
          total: true,
          taxAmount: true,
          invoice: {
            select: {
              ...BREAKDOWN_INVOICE_SELECT,
              correctionMethod: true,
              // Un abono se reparte como la factura que corrige; una sustitutiva
              // cuenta solo la diferencia con la sustituida (como en los libros).
              rectifiesInvoice: {
                select: {
                  ...BREAKDOWN_INVOICE_SELECT,
                  items: { select: { description: true, total: true, taxAmount: true } },
                },
              },
            },
          },
        },
      });
      return { lines, from, to };
    }, tenantId);

    const concepts = new Map<RevenueConcept, number>();
    const facilities = new Map<string, { label: string; amount: number }>();
    const types = new Map<string, { label: string; amount: number }>();
    let total = 0;

    type Source = {
      contractId: string | null;
      lateFeeForInvoiceId: string | null;
      facility: { id: string; name: string } | null;
      productSale: { id: string; facility: { id: string; name: string } | null } | null;
      contract: {
        unit: {
          facility: { id: string; name: string };
          unitType: { id: string; name: string } | null;
        };
      } | null;
    };
    const add = (description: string, base: number, inv: Source) => {
      const concept = conceptOf(description, {
        lateFeeForInvoiceId: inv.lateFeeForInvoiceId,
        contractId: inv.contractId,
        saleId: inv.productSale?.id ?? null,
      });
      if (!concept) return;
      total += base;
      concepts.set(concept, (concepts.get(concept) ?? 0) + base);
      const facility =
        inv.contract?.unit.facility ?? inv.facility ?? inv.productSale?.facility ?? null;
      const fKey = facility?.id ?? 'none';
      const f = facilities.get(fKey) ?? { label: facility?.name ?? 'Sin local', amount: 0 };
      f.amount += base;
      facilities.set(fKey, f);
      const type = inv.contract?.unit.unitType;
      if (concept === 'rent' && type) {
        const t = types.get(type.id) ?? { label: type.name, amount: 0 };
        t.amount += base;
        types.set(type.id, t);
      }
    };

    const substituted = new Set<string>();
    for (const it of lines) {
      const inv = it.invoice;
      const original = inv.rectifiesInvoice;
      add(it.description, Number(it.total) - Number(it.taxAmount), original ?? inv);
      if (inv.correctionMethod === 'by_substitution' && original && !substituted.has(inv.id)) {
        substituted.add(inv.id);
        for (const o of original.items) {
          add(o.description, -(Number(o.total) - Number(o.taxAmount)), original);
        }
      }
    }

    const rows = (m: Map<string, { label: string; amount: number }>): RevenueBreakdownRowDto[] =>
      [...m.entries()]
        .map(([key, v]) => ({ key, label: v.label, amount: round2(v.amount) }))
        .sort((a, b) => b.amount - a.amount);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      total: round2(total),
      byConcept: [...concepts.entries()]
        .map(([key, amount]) => ({ key, label: CONCEPT_LABELS[key], amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      byFacility: rows(facilities),
      byUnitType: rows(types),
    };
  }

  /**
   * Cohortes de altas: los contratos agrupados por el mes en que empezaron,
   * cuántos seguían a los 3, 6 y 12 meses, cuánto duraron y cuánto facturaron.
   */
  /** Motivos de baja de la encuesta de salida, por las enviadas en el periodo. */
  async getExitReasons(
    tenantId: string,
    range: { months?: number; from?: string; to?: string } = {},
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<ExitReasonsDto> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      // El periodo elegido en la página (meses `YYYY-MM`), o los últimos N meses.
      const today = todayInTimezone(timezone);
      const curIdx = today.getUTCFullYear() * 12 + today.getUTCMonth();
      const fromIdx = parseMonth(range.from, 'from');
      const toIdx = parseMonth(range.to, 'to');
      let startIdx = curIdx - (clampMonths(range.months) - 1);
      let endIdx = curIdx;
      if (fromIdx !== null && toIdx !== null) {
        startIdx = Math.min(fromIdx, toIdx);
        endIdx = Math.min(curIdx, Math.max(fromIdx, toIdx));
      }
      const year = (idx: number) => Math.floor(idx / 12);
      const month = (idx: number) => (idx % 12) + 1;
      return tx.review.findMany({
        where: {
          tenantId,
          source: 'reviews.exit',
          requestedAt: {
            gte: zonedMonthStart(year(startIdx), month(startIdx), timezone),
            lt: zonedMonthStart(year(endIdx), month(endIdx) + 1, timezone),
          },
          ...(scope.ids ? { contract: { unit: { facilityId: { in: scope.ids } } } } : {}),
        },
        select: { status: true, npsScore: true, exitReason: true },
      });
    }, tenantId);
    const answered = rows.filter((r) => r.status === 'submitted');
    const scores = answered.flatMap((r) => (r.npsScore === null ? [] : [r.npsScore]));
    const nps =
      scores.length > 0
        ? Math.round(
            ((scores.filter((n) => n >= 9).length - scores.filter((n) => n <= 6).length) /
              scores.length) *
              100,
          )
        : null;
    const count = (reason: string | null) =>
      answered.filter((r) => (r.exitReason ?? null) === reason).length;
    const pct = (n: number) => (answered.length > 0 ? Math.round((n / answered.length) * 100) : 0);
    const reasons = [
      ...REVIEW_EXIT_REASONS.map((reason) => ({
        reason: reason as string,
        label: REVIEW_EXIT_REASON_LABELS[reason],
        count: count(reason),
      })),
      { reason: 'not_given', label: 'No lo dijo', count: count(null) },
    ]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ ...r, pct: pct(r.count) }));
    return { sent: rows.length, answered: answered.length, nps, reasons };
  }

  async getCohorts(
    tenantId: string,
    months?: number,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<CohortsDto> {
    const count = clampMonths(months);

    const { contracts, timezone, today } = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const today = todayInTimezone(timezone);
      const curIdx = today.getUTCFullYear() * 12 + today.getUTCMonth();
      const startIdx = curIdx - (count - 1);
      const since = zonedMonthStart(Math.floor(startIdx / 12), (startIdx % 12) + 1, timezone);
      const contracts = await tx.contract.findMany({
        where: {
          AND: [
            SIGNED_CONTRACT_WHERE,
            contractWhere(scope),
            // Solo los que empezaron en el periodo (empiezan al firmar o en su
            // fecha de inicio, lo que sea más tarde).
            { OR: [{ signedAt: { gte: since } }, { startDate: { gte: since } }] },
          ],
        },
        select: {
          ...LIFECYCLE_SELECT,
          invoices: {
            where: {
              kind: 'invoice',
              deletedAt: null,
              status: { in: [...INVOICED_STATUSES] },
              ...invoiceWhere(scope),
            },
            select: INVOICED_SELECT,
          },
        },
      });
      return { contracts, timezone, today };
    }, tenantId);

    const now = new Date();
    const curIdx = today.getUTCFullYear() * 12 + today.getUTCMonth();
    const startIdx = curIdx - (count - 1);
    const groups = new Map<number, { begin: Date; end: Date | null; revenue: number }[]>();
    for (const c of contracts) {
      const life = contractLifecycle(c);
      if (!life) continue;
      const idx = monthIdx(life.begin, timezone);
      if (idx < startIdx || idx > curIdx) continue;
      // Lo facturado como en Ingresos: anular resta, una sustitutiva cuenta la diferencia.
      const revenue = c.invoices.reduce((sum, i) => sum + invoicedAmount(i), 0);
      const list = groups.get(idx) ?? [];
      list.push({ begin: life.begin, end: life.end, revenue });
      groups.set(idx, list);
    }

    const retained = (
      idx: number,
      list: { begin: Date; end: Date | null }[],
      monthsAfter: number,
    ) => {
      // Solo si ya ha pasado ese tiempo para todo el mes de alta.
      const reachIdx = idx + 1 + monthsAfter;
      if (zonedMonthStart(Math.floor(reachIdx / 12), (reachIdx % 12) + 1, timezone) > now) {
        return null;
      }
      const alive = list.filter((x) => {
        const at = new Date(x.begin);
        at.setUTCMonth(at.getUTCMonth() + monthsAfter);
        return !x.end || x.end >= at;
      }).length;
      return alive / list.length;
    };

    const cohorts: CohortRowDto[] = [];
    for (let idx = curIdx; idx >= startIdx; idx--) {
      const list = groups.get(idx);
      if (!list || list.length === 0) continue;
      const stay =
        list.reduce(
          (sum, x) => sum + ((x.end ?? now).getTime() - x.begin.getTime()) / (30.44 * DAY),
          0,
        ) / list.length;
      cohorts.push({
        yearMonth: monthKey(idx),
        contracts: list.length,
        retained3: retained(idx, list, 3),
        retained6: retained(idx, list, 6),
        retained12: retained(idx, list, 12),
        avgStayMonths: Math.round(stay * 10) / 10,
        revenuePerContract: round2(list.reduce((sum, x) => sum + x.revenue, 0) / list.length),
      });
    }
    return { cohorts };
  }

  /**
   * Preventa de los locales por abrir: cuántos trasteros están ya reservados
   * (por tipo), cuántos sin pagar y las cuotas que empezarán el día de apertura.
   */
  async getPreOpening(tenantId: string, scope: AnalyticsScope): Promise<PreOpeningAnalyticsDto> {
    const facilities = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findMany({
          where: {
            deletedAt: null,
            preOpening: true,
            ...(scope.ids ? { id: { in: scope.ids } } : {}),
          },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            openingDate: true,
            units: {
              select: {
                status: true,
                basePriceMonthly: true,
                unitTypeId: true,
                unitType: { select: { name: true } },
                contracts: {
                  where: {
                    preOpening: true,
                    preOpeningStartedAt: null,
                    status: { in: ['active', 'ending'] },
                    deletedAt: null,
                  },
                  select: {
                    priceMonthly: true,
                    discountAmount: true,
                    invoices: {
                      where: { kind: 'invoice', deletedAt: null },
                      select: { status: true },
                    },
                  },
                },
              },
            },
          },
        }),
      tenantId,
    );
    return {
      facilities: facilities.map((f) => {
        const rentable = f.units.filter(
          (u) => u.status !== 'maintenance' && u.status !== 'blocked',
        );
        const reservations = f.units.flatMap((u) => u.contracts);
        const types = new Map<
          string,
          PreOpeningAnalyticsDto['facilities'][number]['byType'][number]
        >();
        for (const u of f.units) {
          const key = u.unitTypeId ?? 'none';
          const row = types.get(key) ?? {
            unitTypeId: u.unitTypeId,
            name: u.unitType?.name ?? 'Sin tipo',
            total: 0,
            reserved: 0,
            available: 0,
            fromPrice: null,
          };
          row.total += 1;
          if (u.contracts.length > 0) row.reserved += 1;
          if (u.status === 'available') {
            row.available += 1;
            const price = Number(u.basePriceMonthly);
            row.fromPrice = row.fromPrice === null ? price : Math.min(row.fromPrice, price);
          }
          types.set(key, row);
        }
        return {
          facilityId: f.id,
          facilityName: f.name,
          openingDate: f.openingDate ? f.openingDate.toISOString().slice(0, 10) : null,
          totalUnits: f.units.length,
          reserved: f.units.filter((u) => u.contracts.length > 0).length,
          unpaid: reservations.filter((c) => !c.invoices.some((i) => i.status === 'paid')).length,
          available: f.units.filter((u) => u.status === 'available').length,
          reservedMrr: round2(
            reservations.reduce(
              (sum, c) => sum + Number(c.priceMonthly) - Number(c.discountAmount),
              0,
            ),
          ),
          potentialMrr: round2(rentable.reduce((sum, u) => sum + Number(u.basePriceMonthly), 0)),
          byType: [...types.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
        };
      }),
    };
  }
}
