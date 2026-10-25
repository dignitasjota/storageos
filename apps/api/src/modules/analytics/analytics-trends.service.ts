import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import {
  ALL_FACILITIES,
  contractLifecycle,
  contractWhere,
  invalidDate,
  invoiceWhere,
  LIFECYCLE_SELECT,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';

import type {
  CohortRowDto,
  CohortsDto,
  OccupancyHistoryDto,
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

/** Primer instante del mes siguiente al índice (año × 12 + mes 0-11). */
function monthEnd(idx: number): Date {
  return new Date(Date.UTC(Math.floor((idx + 1) / 12), (idx + 1) % 12, 1));
}

function clampMonths(months?: number): number {
  return Math.max(1, Math.min(MONTHS_MAX, Math.floor(months ?? 12) || 12));
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
  if (invoice.contractId) return 'rent';
  return 'other';
}

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
    const now = new Date();
    const curIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
    const idxs = Array.from({ length: count }, (_, i) => curIdx - (count - 1) + i);

    const { units, contracts } = await this.prisma.withTenant(async (tx) => {
      const [units, contracts] = await Promise.all([
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
        tx.contract.findMany({
          where: { signedAt: { not: null }, deletedAt: null, ...contractWhere(scope) },
          select: { ...LIFECYCLE_SELECT, unitId: true, priceMonthly: true, discountAmount: true },
        }),
      ]);
      return { units, contracts };
    }, tenantId);

    const lives = contracts
      .map((c) => ({ c, life: contractLifecycle(c) }))
      .filter(
        (
          x,
        ): x is {
          c: (typeof contracts)[number];
          life: NonNullable<ReturnType<typeof contractLifecycle>>;
        } => x.life !== null,
      );

    // Para cada mes: trasteros existentes y los ocupados (con contrato vivo).
    const snapshots = idxs.map((idx) => {
      const at = idx === curIdx ? now : monthEnd(idx);
      const atMs = at.getTime();
      const existing = units.filter((u) => u.createdAt.getTime() < atMs);
      const occupied = new Set<string>();
      let mrr = 0;
      for (const { c, life } of lives) {
        if (life.begin.getTime() >= atMs) continue;
        if (life.end && life.end.getTime() < atMs) continue;
        occupied.add(c.unitId);
        mrr += Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount));
      }
      return { idx, existing, occupied, mrr };
    });

    const points = snapshots.map((s) => {
      const occ = s.existing.filter((u) => s.occupied.has(u.id)).length;
      return {
        yearMonth: monthKey(s.idx),
        totalUnits: s.existing.length,
        occupiedUnits: occ,
        occupancy: s.existing.length === 0 ? 0 : occ / s.existing.length,
        mrr: round2(s.mrr),
      };
    });

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
      points,
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
    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const from = range.from ? parseDay(range.from, 'from') : defaultFrom;
    const to = range.to
      ? parseDay(range.to, 'to')
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const toExclusive = new Date(to.getTime() + DAY);

    const items = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceItem.findMany({
          where: {
            invoice: {
              kind: 'invoice',
              deletedAt: null,
              status: { notIn: ['draft', 'cancelled'] },
              issueDate: { gte: from, lt: toExclusive },
              ...invoiceWhere(scope),
            },
          },
          select: {
            description: true,
            total: true,
            taxAmount: true,
            invoice: {
              select: {
                contractId: true,
                lateFeeForInvoiceId: true,
                facility: { select: { id: true, name: true } },
                productSale: {
                  select: { id: true, facility: { select: { id: true, name: true } } },
                },
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
              },
            },
          },
        }),
      tenantId,
    );

    const concepts = new Map<RevenueConcept, number>();
    const facilities = new Map<string, { label: string; amount: number }>();
    const types = new Map<string, { label: string; amount: number }>();
    let total = 0;
    for (const it of items) {
      const inv = it.invoice;
      const concept = conceptOf(it.description, {
        lateFeeForInvoiceId: inv.lateFeeForInvoiceId,
        contractId: inv.contractId,
        saleId: inv.productSale?.id ?? null,
      });
      if (!concept) continue;
      const base = Number(it.total) - Number(it.taxAmount);
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
  async getCohorts(
    tenantId: string,
    months?: number,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<CohortsDto> {
    const count = clampMonths(months);
    const now = new Date();
    const curIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
    const startIdx = curIdx - (count - 1);

    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { signedAt: { not: null }, deletedAt: null, ...contractWhere(scope) },
          select: {
            ...LIFECYCLE_SELECT,
            invoices: {
              where: {
                kind: 'invoice',
                deletedAt: null,
                status: { notIn: ['draft', 'cancelled'] },
              },
              select: { total: true },
            },
          },
        }),
      tenantId,
    );

    const groups = new Map<number, { begin: Date; end: Date | null; revenue: number }[]>();
    for (const c of contracts) {
      const life = contractLifecycle(c);
      if (!life) continue;
      const idx = life.begin.getUTCFullYear() * 12 + life.begin.getUTCMonth();
      if (idx < startIdx || idx > curIdx) continue;
      const revenue = c.invoices.reduce((sum, i) => sum + Number(i.total), 0);
      const list = groups.get(idx) ?? [];
      list.push({ begin: life.begin, end: life.end, revenue });
      groups.set(idx, list);
    }

    const retained = (list: { begin: Date; end: Date | null }[], monthsAfter: number) => {
      // Solo si ya ha pasado ese tiempo para todo el mes de alta.
      const first = list[0]!.begin;
      const groupEnd = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      const reach = new Date(groupEnd);
      reach.setUTCMonth(reach.getUTCMonth() + monthsAfter);
      if (reach > now) return null;
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
        retained3: retained(list, 3),
        retained6: retained(list, 6),
        retained12: retained(list, 12),
        avgStayMonths: Math.round(stay * 10) / 10,
        revenuePerContract: round2(list.reduce((sum, x) => sum + x.revenue, 0) / list.length),
      });
    }
    return { cohorts };
  }
}
