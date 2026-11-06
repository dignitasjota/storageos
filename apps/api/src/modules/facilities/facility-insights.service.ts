import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UNIT_HOLD_LABELS } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart } from '../../common/format';
import { describeUnitHold } from '../../common/unit-holds';
import {
  contractWhere,
  LIVE_CONTRACT_WHERE,
  liveMrr,
  unitWhere,
  type AnalyticsScope,
} from '../analytics/analytics-scope';
import {
  contractMoves,
  INVOICED_SELECT,
  invoicedAmount,
  invoicedWhere,
  receivables,
  tenantTimezone,
  testRunUnits,
  unitCounts,
} from '../analytics/business-metrics';
import { PrismaService } from '../database/prisma.service';

import { FacilityFloorsService } from './facility-floors.service';

import type { Env } from '../../config/env.schema';
import type {
  FacilityHistoryDto,
  FacilityOverviewDto,
  FacilitySummaryDto,
  FacilityTeamMemberDto,
  FloorHoldDto,
  FloorOccupantDto,
  UnitHoldDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const HISTORY_PAGE = 30;
const DOCUMENT_NOTICE_DAYS = 30;
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
    private readonly config: ConfigService<Env, true>,
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
    const data = await this.prisma.withTenant(
      async (tx) => {
        const timezone = await tenantTimezone(tx, tenantId);
        const today = todayInTimezone(timezone, now);
        const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
        const monthFrom = zonedDayStart(monthStart.toISOString().slice(0, 10), timezone);
        const monthTo = zonedDayStart(nextMonth.toISOString().slice(0, 10), timezone);
        const units = unitWhere(scope);
        const [facilities, rows, counts, testUnits, contracts, invoices, freed] = await Promise.all(
          [
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
          ],
        );
        // Deuda, altas y bajas: por local, con las definiciones del Resumen.
        const perFacility = new Map(
          await Promise.all(
            facilities.map(async (f) => {
              const one: AnalyticsScope = { ids: [f.id], explicit: true };
              const [debt, moves] = await Promise.all([
                money ? receivables(tx, one, today) : null,
                contractMoves(tx, one, monthFrom, monthTo),
              ]);
              return [f.id, { overdue: debt?.overdue ?? null, moves }] as const;
            }),
          ),
        );
        return { facilities, rows, counts, testUnits, contracts, invoices, freed, perFacility };
        // Varias consultas por local: con muchos no debe saltar el plazo de la transacción.
      },
      tenantId,
      { timeout: 20_000 },
    );

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
        overdue: data.perFacility.get(f.id)?.overdue ?? null,
        moveIns: data.perFacility.get(f.id)?.moves.moveIns ?? 0,
        moveOuts: data.perFacility.get(f.id)?.moves.moveOuts ?? 0,
        longestVacantDays: vacantDays.length > 0 ? Math.max(...vacantDays) : null,
        outOfService: units.filter((u) => u.status === 'maintenance' || u.status === 'blocked')
          .length,
      };
    });
  }

  /** Lo que pasa en un local, de un vistazo. */
  async overview(
    tenantId: string,
    facilityId: string,
    options: { moneyVisible: boolean },
  ): Promise<FacilityOverviewDto> {
    const one: AnalyticsScope = { ids: [facilityId], explicit: true };
    const data = await this.prisma.withTenant(async (tx) => {
      const facility = await tx.facility.findFirst({
        where: { id: facilityId, deletedAt: null },
        select: { publicSlug: true, isActive: true },
      });
      if (!facility) {
        throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
      }
      const timezone = await tenantTimezone(tx, tenantId);
      const now = new Date();
      const today = todayInTimezone(timezone, now);
      const liveContract = {
        status: { in: ['active', 'ending'] as ('active' | 'ending')[] },
        deletedAt: null,
        unit: { facilityId },
      };
      const [
        tenant,
        units,
        testUnits,
        mrr,
        debt,
        moves,
        waitlist,
        tenantsReachable,
        openIncidents,
        documents,
        offlineDevices,
      ] = await Promise.all([
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
        }),
        tx.unit.findMany({
          where: { facilityId },
          select: {
            id: true,
            status: true,
            basePriceMonthly: true,
            unitTypeId: true,
            unitType: { select: { name: true, color: true, defaultPriceMonthly: true } },
          },
        }),
        testRunUnits(tx, unitWhere(one)),
        options.moneyVisible ? liveMrr(tx, one) : null,
        options.moneyVisible ? receivables(tx, one, today) : null,
        contractMoves(tx, one, new Date(now.getTime() - 30 * DAY), now),
        tx.waitlistEntry.count({ where: { facilityId, status: 'waiting' } }),
        tx.customer.count({
          where: {
            deletedAt: null,
            isTest: false,
            email: { not: null },
            contracts: { some: liveContract },
          },
        }),
        tx.incident.count({
          where: { facilityId, deletedAt: null, status: { in: ['reported', 'investigating'] } },
        }),
        tx.facilityDocument.findMany({
          where: {
            facilityId,
            expiresOn: { not: null, lte: new Date(today.getTime() + DOCUMENT_NOTICE_DAYS * DAY) },
          },
          orderBy: { expiresOn: 'asc' },
          select: { id: true, name: true, expiresOn: true },
        }),
        tx.accessDevice.findMany({
          where: {
            facilityId,
            isActive: true,
            isOnline: false,
            // Del que no se puede consultar ni manda latido no se sabe nada.
            OR: [{ controlUrl: { not: null } }, { lastHeartbeatAt: { not: null } }],
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]);
      return {
        facility,
        tenant,
        units,
        testUnits,
        mrr,
        debt,
        moves,
        waitlist,
        tenantsReachable,
        openIncidents,
        documents,
        offlineDevices,
        today,
      };
    }, tenantId);

    const onTest = new Set(data.testUnits.map((u) => u.id));
    const byType = new Map<string, FacilityOverviewDto['byType'][number]>();
    const prices = new Map<string, number>();
    for (const u of data.units) {
      const row = byType.get(u.unitTypeId) ?? {
        unitTypeId: u.unitTypeId,
        name: u.unitType.name,
        color: u.unitType.color,
        defaultPriceMonthly: Number(u.unitType.defaultPriceMonthly),
        total: 0,
        occupied: 0,
        reserved: 0,
        available: 0,
        outOfService: 0,
        avgPrice: 0,
      };
      row.total += 1;
      // En manos del inquilino de prueba, para las cifras sigue libre.
      if (onTest.has(u.id) || u.status === 'available') row.available += 1;
      else if (u.status === 'occupied') row.occupied += 1;
      else if (u.status === 'reserved') row.reserved += 1;
      else row.outOfService += 1;
      prices.set(u.unitTypeId, (prices.get(u.unitTypeId) ?? 0) + Number(u.basePriceMonthly));
      byType.set(u.unitTypeId, row);
    }
    return {
      publicUrl: this.publicUrl(data.tenant, data.facility),
      byType: [...byType.values()]
        .map((t) => ({ ...t, avgPrice: round2((prices.get(t.unitTypeId) ?? 0) / t.total) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
      mrr: data.mrr?.mrr ?? null,
      overdue: data.debt?.overdue ?? null,
      moveIns: data.moves.moveIns,
      moveOuts: data.moves.moveOuts,
      waitlist: data.waitlist,
      tenantsReachable: data.tenantsReachable,
      openIncidents: data.openIncidents,
      expiringDocuments: data.documents.map((d) => ({
        id: d.id,
        name: d.name,
        expiresOn: d.expiresOn!.toISOString().slice(0, 10),
        daysToExpiry: Math.round((d.expiresOn!.getTime() - data.today.getTime()) / DAY),
      })),
      offlineDevices: data.offlineDevices,
    };
  }

  /** Su página en la web, con el dominio propio si está activo. */
  private publicUrl(
    tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
    facility: { publicSlug: string | null; isActive: boolean },
  ): string | null {
    if (!facility.publicSlug || !facility.isActive) return null;
    if (tenant.customDomain && tenant.customDomainVerifiedAt) {
      return `https://${tenant.customDomain}/${facility.publicSlug}`;
    }
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    return `${base}/s/${tenant.slug}/${facility.publicSlug}`;
  }

  /** Quién del equipo ve este local: los que lo tienen asignado y los que ven todos. */
  async team(tenantId: string, facilityId: string): Promise<FacilityTeamMemberDto[]> {
    const users = await this.prisma.withTenant(
      (tx) =>
        tx.user.findMany({
          where: { isActive: true },
          orderBy: { fullName: 'asc' },
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            facilities: { select: { facilityId: true } },
          },
        }),
      tenantId,
    );
    return users.flatMap((u): FacilityTeamMemberDto[] => {
      const base = { id: u.id, fullName: u.fullName, email: u.email, role: u.role };
      if (u.role === 'owner' || u.facilities.length === 0) return [{ ...base, access: 'all' }];
      return u.facilities.some((f) => f.facilityId === facilityId)
        ? [{ ...base, access: 'assigned' }]
        : [];
    });
  }

  /** Lo que se ha cambiado en el local y en sus plantas. */
  async history(
    tenantId: string,
    facilityId: string,
    cursor?: string,
  ): Promise<FacilityHistoryDto> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const floors = await tx.facilityFloor.findMany({
        where: { facilityId },
        select: { id: true },
      });
      return tx.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'Facility', entityId: facilityId },
            { entityType: 'FacilityFloor', entityId: { in: floors.map((f) => f.id) } },
            // Las plantas ya borradas: lo apuntado lleva su local.
            { entityType: 'FacilityFloor', changes: { path: ['facilityId'], equals: facilityId } },
          ],
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { user: { select: { fullName: true } } },
      });
    }, tenantId);
    const page = rows.slice(0, HISTORY_PAGE);
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        userName: r.user?.fullName ?? null,
        occurredAt: r.occurredAt.toISOString(),
        changes: (r.changes as Record<string, unknown>) ?? null,
      })),
      nextCursor: rows.length > HISTORY_PAGE ? (page[page.length - 1]?.id ?? null) : null,
    };
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
