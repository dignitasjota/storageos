import { Injectable } from '@nestjs/common';
import { lostUnitIncome } from '@storageos/shared';

import { resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { overdueInvoiceWhere } from '../dashboard/today-filters';
import { PrismaService } from '../database/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';

import { UnitsService, UNIT_INCLUDE } from './units.service';

import type { Prisma } from '@storageos/database';
import type {
  SaveUnitViewInput,
  UnitOverviewRowDto,
  UnitSavedViewDto,
  UnitsOverviewDto,
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

/** La lista de Trasteros: cada trastero con su inquilino, cuota, deuda y días libre. */
@Injectable()
export class UnitsOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
    private readonly promotions: PromotionsService,
  ) {}

  async overview(
    tenantId: string,
    args: {
      facilityId?: string;
      facilityScope?: string[] | null;
      tenantsVisible: boolean;
      moneyVisible: boolean;
    },
  ): Promise<UnitsOverviewDto> {
    const { tenantsVisible, moneyVisible } = args;
    const empty = { rows: [], tenantsVisible, moneyVisible };
    const facFilter = resolveFacilityFilter(args.facilityScope, args.facilityId);
    if (facFilter === null) return empty;
    const where: Prisma.UnitWhereInput = {
      facility: { deletedAt: null },
      ...(facFilter ? { facilityId: { in: facFilter } } : {}),
    };

    const data = await this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const startOfToday = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
      const [units, contracts, freed] = await Promise.all([
        tx.unit.findMany({ where, orderBy: { code: 'asc' }, include: UNIT_INCLUDE }),
        tenantsVisible
          ? tx.contract.findMany({
              where: {
                status: { in: ['active', 'ending'] },
                deletedAt: null,
                ...STARTED_CONTRACT_WHERE,
                unit: where,
              },
              select: {
                id: true,
                contractNumber: true,
                unitId: true,
                customerId: true,
                priceMonthly: true,
                discountAmount: true,
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
                invoices: moneyVisible
                  ? {
                      where: overdueInvoiceWhere(startOfToday),
                      select: { total: true, amountPaid: true },
                    }
                  : false,
              },
            })
          : Promise.resolve([]),
        tx.unitStatusHistory.groupBy({
          by: ['unitId'],
          where: { newStatus: 'available', unit: where },
          _max: { occurredAt: true },
        }),
      ]);
      return { units, contracts, freed };
    }, tenantId);

    const offers = new Map(
      (
        await this.promotions.activeUnitOffers(
          tenantId,
          data.units.map((u) => u.id),
        )
      ).map((o) => [o.unitId, o]),
    );
    const contractByUnit = new Map(data.contracts.map((c) => [c.unitId, c]));
    const lastFree = new Map(data.freed.map((f) => [f.unitId, f._max.occurredAt]));
    const now = Date.now();

    const rows = data.units.map((u): UnitOverviewRowDto => {
      const dto = this.units.toDto(u);
      const contract = contractByUnit.get(u.id);
      const offer = offers.get(u.id);
      const stoppedDays = u.outOfServiceSince
        ? Math.floor((now - u.outOfServiceSince.getTime()) / DAY)
        : null;
      return {
        ...dto,
        tenant: contract
          ? {
              customerId: contract.customerId,
              customerName: customerName(contract.customer),
              contractId: contract.id,
              contractNumber: contract.contractNumber,
              monthly: round2(
                Math.max(0, Number(contract.priceMonthly) - Number(contract.discountAmount)),
              ),
              overdue: moneyVisible
                ? round2(
                    (contract.invoices ?? []).reduce(
                      (sum, i) => sum + Number(i.total) - Number(i.amountPaid),
                      0,
                    ),
                  )
                : null,
            }
          : null,
        daysVacant:
          u.status === 'available'
            ? Math.floor((now - (lastFree.get(u.id) ?? u.createdAt).getTime()) / DAY)
            : null,
        offer: offer
          ? { code: offer.code, freeMonths: offer.freeMonths, validUntil: offer.validUntil }
          : null,
        outOfService:
          (u.status === 'maintenance' || u.status === 'blocked') && stoppedDays !== null
            ? {
                days: stoppedDays,
                lostIncome: lostUnitIncome(dto.basePriceMonthly, stoppedDays),
              }
            : null,
      };
    });
    return { rows, tenantsVisible, moneyVisible };
  }

  async listViews(tenantId: string): Promise<UnitSavedViewDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitSavedView.findMany({
          orderBy: { name: 'asc' },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      filters: r.filters as Record<string, unknown>,
      createdByName: r.createdBy?.fullName ?? null,
    }));
  }

  /** Guardar con un nombre que ya existe la sustituye. */
  async saveView(
    tenantId: string,
    userId: string,
    input: SaveUnitViewInput,
  ): Promise<UnitSavedViewDto> {
    const filters = input.filters as Prisma.InputJsonValue;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.unitSavedView.upsert({
          where: { tenantId_name: { tenantId, name: input.name } },
          create: { tenantId, name: input.name, filters, createdByUserId: userId },
          update: { filters },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return {
      id: row.id,
      name: row.name,
      filters: row.filters as Record<string, unknown>,
      createdByName: row.createdBy?.fullName ?? null,
    };
  }

  async deleteView(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant((tx) => tx.unitSavedView.deleteMany({ where: { id } }), tenantId);
  }
}
