import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { OccupancyDashboardDto, UnitStatusValue } from '@storageos/shared';

const STATUSES: UnitStatusValue[] = ['available', 'occupied', 'reserved', 'maintenance', 'blocked'];

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async occupancy(tenantId: string): Promise<OccupancyDashboardDto> {
    return this.prisma.withTenant(async (tx) => {
      const allUnits = await tx.unit.findMany({
        select: {
          status: true,
          facilityId: true,
          unitTypeId: true,
          facility: { select: { name: true, deletedAt: true } },
          unitType: { select: { name: true, color: true } },
        },
      });
      const totalUnits = allUnits.length;

      const byStatus = STATUSES.reduce<Record<UnitStatusValue, number>>(
        (acc, s) => ({ ...acc, [s]: 0 }),
        {} as Record<UnitStatusValue, number>,
      );
      const facilityAgg = new Map<string, { name: string; total: number; occupied: number }>();
      const typeAgg = new Map<
        string,
        { name: string; color: string; total: number; occupied: number }
      >();

      for (const u of allUnits) {
        // Excluir units de facilities soft-deleted.
        if (u.facility.deletedAt) continue;
        byStatus[u.status as UnitStatusValue] = (byStatus[u.status as UnitStatusValue] ?? 0) + 1;

        const fac = facilityAgg.get(u.facilityId) ?? {
          name: u.facility.name,
          total: 0,
          occupied: 0,
        };
        fac.total += 1;
        if (u.status === 'occupied') fac.occupied += 1;
        facilityAgg.set(u.facilityId, fac);

        const typ = typeAgg.get(u.unitTypeId) ?? {
          name: u.unitType.name,
          color: u.unitType.color,
          total: 0,
          occupied: 0,
        };
        typ.total += 1;
        if (u.status === 'occupied') typ.occupied += 1;
        typeAgg.set(u.unitTypeId, typ);
      }

      const byFacility = [...facilityAgg.entries()]
        .map(([facilityId, v]) => ({
          facilityId,
          facilityName: v.name,
          totalUnits: v.total,
          occupiedUnits: v.occupied,
          occupancyPct: v.total > 0 ? Math.round((v.occupied / v.total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => a.facilityName.localeCompare(b.facilityName));

      const byUnitType = [...typeAgg.entries()]
        .map(([unitTypeId, v]) => ({
          unitTypeId,
          unitTypeName: v.name,
          color: v.color,
          totalUnits: v.total,
          occupiedUnits: v.occupied,
          occupancyPct: v.total > 0 ? Math.round((v.occupied / v.total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => a.unitTypeName.localeCompare(b.unitTypeName));

      return {
        totalUnits,
        byStatus,
        byFacility,
        byUnitType,
      };
    }, tenantId);
  }
}
