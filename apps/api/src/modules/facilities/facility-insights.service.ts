import { Injectable, NotFoundException } from '@nestjs/common';
import { UNIT_HOLD_LABELS } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { describeUnitHold } from '../../common/unit-holds';
import {
  contractWhere,
  LIVE_CONTRACT_WHERE,
  unitWhere,
  type AnalyticsScope,
} from '../analytics/analytics-scope';
import {
  INVOICED_SELECT,
  invoicedAmount,
  invoicedWhere,
  tenantTimezone,
  testRunUnits,
  unitCounts,
} from '../analytics/business-metrics';
import { PrismaService } from '../database/prisma.service';

import { FacilityFloorsService } from './facility-floors.service';

import type {
  FacilitySummaryDto,
  FloorHoldDto,
  FloorOccupantDto,
  UnitHoldDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente';
}

/** Cifras para comparar locales y quién ocupa cada trastero del plano. */
@Injectable()
export class FacilityInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly floors: FacilityFloorsService,
  ) {}

  /** Cifras de cada local, con las mismas definiciones que el Resumen. */
  async summary(
    tenantId: string,
    facilityScope: string[] | null,
    options: { moneyVisible: boolean },
  ): Promise<FacilitySummaryDto[]> {
    const facFilter = resolveFacilityFilter(facilityScope);
    if (facFilter === null) return [];
    const now = new Date();
    const scope: AnalyticsScope = { ids: facFilter, explicit: false };
    const money = options.moneyVisible;
    const data = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const today = todayInTimezone(timezone, now);
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      const units = unitWhere(scope);
      const [facilities, rows, counts, testUnits, contracts, invoices, freed] = await Promise.all([
        tx.facility.findMany({
          where: { deletedAt: null, ...(facFilter ? { id: { in: facFilter } } : {}) },
          select: { id: true },
        }),
        tx.unit.findMany({
          where: units,
          select: { id: true, facilityId: true, status: true, areaM2: true, createdAt: true },
        }),
        unitCounts(tx, scope),
        testRunUnits(tx, units),
        money
          ? tx.contract.findMany({
              where: { ...LIVE_CONTRACT_WHERE, ...contractWhere(scope) },
              select: {
                priceMonthly: true,
                discountAmount: true,
                unit: { select: { facilityId: true } },
              },
            })
          : [],
        money
          ? tx.invoice.findMany({
              where: invoicedWhere(scope, monthStart, nextMonth),
              select: {
                ...INVOICED_SELECT,
                facilityId: true,
                contract: { select: { unit: { select: { facilityId: true } } } },
                productSale: { select: { facilityId: true } },
              },
            })
          : [],
        tx.unitStatusHistory.groupBy({
          by: ['unitId'],
          where: { newStatus: 'available' },
          _max: { occurredAt: true },
        }),
      ]);
      return { facilities, rows, counts, testUnits, contracts, invoices, freed };
    }, tenantId);

    const lastFree = new Map(data.freed.map((f) => [f.unitId, f._max.occurredAt]));
    const onTest = new Set(data.testUnits.map((u) => u.id));
    return data.facilities.map((f) => {
      const units = data.rows.filter((u) => u.facilityId === f.id);
      const live = data.contracts.filter((c) => c.unit.facilityId === f.id);
      const mrr = live.reduce(
        (sum, c) => sum + Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)),
        0,
      );
      const vacantDays = units
        .filter((u) => u.status === 'available')
        .map((u) =>
          Math.floor((now.getTime() - (lastFree.get(u.id) ?? u.createdAt).getTime()) / DAY),
        );
      const invoiced = data.invoices
        .filter(
          (i) =>
            (i.contract?.unit.facilityId ?? i.facilityId ?? i.productSale?.facilityId) === f.id,
        )
        .reduce((sum, i) => sum + invoicedAmount(i), 0);
      const counts = data.counts.byFacility.get(f.id) ?? {};
      return {
        facilityId: f.id,
        totalUnits: Object.values(counts).reduce((sum, n) => sum + n, 0),
        occupiedUnits: counts.occupied ?? 0,
        mrr: money ? round2(mrr) : null,
        avgPrice: money && live.length > 0 ? round2(mrr / live.length) : null,
        totalM2: round2(units.reduce((s, u) => s + Number(u.areaM2 ?? 0), 0)),
        occupiedM2: round2(
          units
            .filter((u) => u.status === 'occupied' && !onTest.has(u.id))
            .reduce((s, u) => s + Number(u.areaM2 ?? 0), 0),
        ),
        invoicedMonth: money ? round2(invoiced) : null,
        longestVacantDays: vacantDays.length > 0 ? Math.max(...vacantDays) : null,
        outOfService: units.filter((u) => u.status === 'maintenance' || u.status === 'blocked')
          .length,
      };
    });
  }

  /** Para quién está guardado cada trastero reservado de una planta. */
  async holds(
    tenantId: string,
    floorId: string,
    facilityScope?: string[] | null,
  ): Promise<FloorHoldDto[]> {
    const floor = await this.floors.findOrThrow(tenantId, floorId);
    assertFacilityAllowed(facilityScope, floor.facilityId);
    return this.prisma.withTenant(async (tx) => {
      const units = await tx.unit.findMany({
        where: { floorId, status: 'reserved' },
        select: { id: true },
      });
      const rows: FloorHoldDto[] = [];
      for (const u of units) {
        const hold = await describeUnitHold(tx, u.id);
        if (!hold) continue;
        rows.push({
          unitId: u.id,
          label: UNIT_HOLD_LABELS[hold.kind],
          name: hold.name,
          until: hold.until?.toISOString() ?? null,
          link: hold.link,
        });
      }
      return rows;
    }, tenantId);
  }

  /** Quién retiene un trastero. */
  async unitHold(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitHoldDto | null> {
    return this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({
        where: { id: unitId },
        select: { facilityId: true },
      });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      assertFacilityAllowed(facilityScope, unit.facilityId);
      const hold = await describeUnitHold(tx, unitId);
      return hold ? { ...hold, until: hold.until?.toISOString() ?? null } : null;
    }, tenantId);
  }

  /** Inquilino (y su deuda vencida) de cada trastero ocupado de una planta. */
  async occupants(
    tenantId: string,
    floorId: string,
    facilityScope?: string[] | null,
  ): Promise<FloorOccupantDto[]> {
    const floor = await this.floors.findOrThrow(tenantId, floorId);
    assertFacilityAllowed(facilityScope, floor.facilityId);
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, deletedAt: null, unit: { floorId } },
          select: {
            id: true,
            contractNumber: true,
            unitId: true,
            customerId: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                invoices: {
                  where: { status: 'overdue', kind: 'invoice', deletedAt: null },
                  select: { total: true, amountPaid: true },
                },
              },
            },
          },
        }),
      tenantId,
    );
    return contracts.map((c) => ({
      unitId: c.unitId,
      contractId: c.id,
      contractNumber: c.contractNumber,
      customerId: c.customerId,
      customerName: customerName(c.customer),
      overdue: round2(
        c.customer.invoices.reduce((s, i) => s + Number(i.total) - Number(i.amountPaid), 0),
      ),
    }));
  }
}
