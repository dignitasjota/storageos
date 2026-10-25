import { Injectable } from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import { FacilityFloorsService } from './facility-floors.service';

import type { FacilitySummaryDto, FloorOccupantDto } from '@storageos/shared';

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

  async summary(tenantId: string, facilityScope?: string[] | null): Promise<FacilitySummaryDto[]> {
    const facFilter = resolveFacilityFilter(facilityScope);
    if (facFilter === null) return [];
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const scope = facFilter ? { in: facFilter } : undefined;
    const data = await this.prisma.withTenant(async (tx) => {
      const [facilities, units, contracts, invoices, freed] = await Promise.all([
        tx.facility.findMany({
          where: { deletedAt: null, ...(scope ? { id: scope } : {}) },
          select: { id: true },
        }),
        tx.unit.findMany({
          where: { facility: { deletedAt: null }, ...(scope ? { facilityId: scope } : {}) },
          select: { id: true, facilityId: true, status: true, areaM2: true, createdAt: true },
        }),
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            deletedAt: null,
            ...(scope ? { unit: { facilityId: scope } } : {}),
          },
          select: {
            priceMonthly: true,
            discountAmount: true,
            unit: { select: { facilityId: true } },
          },
        }),
        tx.invoice.findMany({
          where: {
            kind: 'invoice',
            deletedAt: null,
            status: { notIn: ['draft', 'cancelled'] },
            issueDate: { gte: monthStart },
          },
          select: {
            total: true,
            facilityId: true,
            contract: { select: { unit: { select: { facilityId: true } } } },
            productSale: { select: { facilityId: true } },
          },
        }),
        tx.unitStatusHistory.groupBy({
          by: ['unitId'],
          where: { newStatus: 'available' },
          _max: { occurredAt: true },
        }),
      ]);
      return { facilities, units, contracts, invoices, freed };
    }, tenantId);

    const lastFree = new Map(data.freed.map((f) => [f.unitId, f._max.occurredAt]));
    return data.facilities.map((f) => {
      const units = data.units.filter((u) => u.facilityId === f.id);
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
        .reduce((sum, i) => sum + Number(i.total), 0);
      return {
        facilityId: f.id,
        mrr: round2(mrr),
        avgPrice: live.length > 0 ? round2(mrr / live.length) : null,
        totalM2: round2(units.reduce((s, u) => s + Number(u.areaM2 ?? 0), 0)),
        occupiedM2: round2(
          units
            .filter((u) => u.status === 'occupied')
            .reduce((s, u) => s + Number(u.areaM2 ?? 0), 0),
        ),
        invoicedMonth: round2(invoiced),
        longestVacantDays: vacantDays.length > 0 ? Math.max(...vacantDays) : null,
        outOfService: units.filter((u) => u.status === 'maintenance' || u.status === 'blocked')
          .length,
      };
    });
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
