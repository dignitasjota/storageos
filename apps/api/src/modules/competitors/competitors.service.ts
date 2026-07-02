import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type {
  CompetitorFacilityDto,
  CompetitorUnitDto,
  CompetitorUnitStatus,
  CreateCompetitorFacilityInput,
  CreateCompetitorUnitInput,
  MarketOccupancyDto,
  UpdateCompetitorFacilityInput,
  UpdateCompetitorUnitInput,
} from '@storageos/shared';

const num = (d: { toString(): string }): number => Number(d.toString());
const cleanText = (v: string | null | undefined): string | null =>
  v && v.trim() ? v.trim() : null;

@Injectable()
export class CompetitorsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- locales de la competencia ----

  async listFacilities(tenantId: string): Promise<CompetitorFacilityDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findMany({
          orderBy: { createdAt: 'asc' },
          include: {
            facility: { select: { name: true } },
            _count: { select: { units: true } },
            units: { select: { status: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      zone: r.zone,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      notes: r.notes,
      unitCount: r._count.units,
      availableCount: r.units.filter((u) => u.status === 'available').length,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Ocupación de mercado: compara mi ocupación física con la de la competencia
   * (inferida de los trasteros fichados con su estado available/occupied). La
   * ocupación de la competencia se pondera por nº de trasteros, no por local
   * (un competidor con 100 trasteros pesa más que uno con 5).
   */
  async getMarketOccupancy(tenantId: string): Promise<MarketOccupancyDto> {
    return this.prisma.withTenant(async (tx) => {
      const [myTotalUnits, myOccupiedUnits, competitors] = await Promise.all([
        tx.unit.count(),
        tx.unit.count({ where: { status: 'occupied' } }),
        tx.competitorFacility.findMany({
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, units: { select: { status: true } } },
        }),
      ]);

      const rows = competitors.map((c) => {
        const unitCount = c.units.length;
        const occupiedCount = c.units.filter((u) => u.status === 'occupied').length;
        return {
          id: c.id,
          name: c.name,
          unitCount,
          occupiedCount,
          occupancyPct: unitCount === 0 ? null : occupiedCount / unitCount,
        };
      });

      const competitionTotalUnits = rows.reduce((s, r) => s + r.unitCount, 0);
      const competitionOccupiedUnits = rows.reduce((s, r) => s + r.occupiedCount, 0);

      return {
        myOccupancyPct: myTotalUnits === 0 ? 0 : myOccupiedUnits / myTotalUnits,
        myOccupiedUnits,
        myTotalUnits,
        competitionOccupancyPct:
          competitionTotalUnits === 0 ? null : competitionOccupiedUnits / competitionTotalUnits,
        competitionOccupiedUnits,
        competitionTotalUnits,
        competitors: rows,
      };
    }, tenantId);
  }

  async createFacility(
    tenantId: string,
    input: CreateCompetitorFacilityInput,
  ): Promise<CompetitorFacilityDto> {
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.create({
          data: {
            tenantId,
            name: input.name.trim(),
            zone: cleanText(input.zone),
            facilityId: input.facilityId ?? null,
            notes: cleanText(input.notes),
          },
        }),
      tenantId,
    );
    return this.facilityToDto(created);
  }

  async updateFacility(
    tenantId: string,
    id: string,
    input: UpdateCompetitorFacilityInput,
  ): Promise<CompetitorFacilityDto> {
    await this.findFacilityOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.zone !== undefined ? { zone: cleanText(input.zone) } : {}),
            ...(input.facilityId !== undefined ? { facilityId: input.facilityId ?? null } : {}),
            ...(input.notes !== undefined ? { notes: cleanText(input.notes) } : {}),
          },
        }),
      tenantId,
    );
    return this.facilityToDto(updated);
  }

  async removeFacility(tenantId: string, id: string): Promise<void> {
    await this.findFacilityOrThrow(tenantId, id);
    await this.prisma.withTenant((tx) => tx.competitorFacility.delete({ where: { id } }), tenantId);
  }

  // ---- trasteros de la competencia ----

  async listUnits(tenantId: string, competitorFacilityId: string): Promise<CompetitorUnitDto[]> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.findMany({
          where: { competitorFacilityId },
          orderBy: { areaM2: 'asc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.unitToDto(r));
  }

  async createUnit(
    tenantId: string,
    competitorFacilityId: string,
    input: CreateCompetitorUnitInput,
  ): Promise<CompetitorUnitDto> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.create({
          data: {
            tenantId,
            competitorFacilityId,
            areaM2: input.areaM2,
            priceMonthly: input.priceMonthly,
            status: input.status,
            notes: cleanText(input.notes),
            lastCheckedAt: new Date(),
          },
        }),
      tenantId,
    );
    return this.unitToDto(created);
  }

  async updateUnit(
    tenantId: string,
    id: string,
    input: UpdateCompetitorUnitInput,
  ): Promise<CompetitorUnitDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.competitorUnit.findFirst({ where: { id, tenantId }, select: { id: true } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'competitor_unit_not_found', message: 'No encontrado' });
    }
    // Si cambia el precio, actualizamos la fecha de comprobación (nueva verificación).
    const touchesPrice = input.priceMonthly !== undefined;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.update({
          where: { id },
          data: {
            ...(input.areaM2 !== undefined ? { areaM2: input.areaM2 } : {}),
            ...(input.priceMonthly !== undefined ? { priceMonthly: input.priceMonthly } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: cleanText(input.notes) } : {}),
            ...(touchesPrice ? { lastCheckedAt: new Date() } : {}),
          },
        }),
      tenantId,
    );
    return this.unitToDto(updated);
  }

  async removeUnit(tenantId: string, id: string): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.competitorUnit.findFirst({ where: { id, tenantId }, select: { id: true } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'competitor_unit_not_found', message: 'No encontrado' });
    }
    await this.prisma.withTenant((tx) => tx.competitorUnit.delete({ where: { id } }), tenantId);
  }

  // ---- helpers ----

  private async findFacilityOrThrow(tenantId: string, id: string): Promise<void> {
    const found = await this.prisma.withTenant(
      (tx) => tx.competitorFacility.findFirst({ where: { id, tenantId }, select: { id: true } }),
      tenantId,
    );
    if (!found) {
      throw new NotFoundException({
        code: 'competitor_facility_not_found',
        message: 'Local de la competencia no encontrado',
      });
    }
  }

  private facilityToDto(r: {
    id: string;
    name: string;
    zone: string | null;
    facilityId: string | null;
    notes: string | null;
    createdAt: Date;
  }): CompetitorFacilityDto {
    return {
      id: r.id,
      name: r.name,
      zone: r.zone,
      facilityId: r.facilityId,
      facilityName: null,
      notes: r.notes,
      unitCount: 0,
      availableCount: 0,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private unitToDto(r: {
    id: string;
    competitorFacilityId: string;
    areaM2: { toString(): string };
    priceMonthly: { toString(): string };
    status: string;
    lastCheckedAt: Date;
    notes: string | null;
  }): CompetitorUnitDto {
    return {
      id: r.id,
      competitorFacilityId: r.competitorFacilityId,
      areaM2: num(r.areaM2),
      priceMonthly: num(r.priceMonthly),
      status: r.status as CompetitorUnitStatus,
      lastCheckedAt: r.lastCheckedAt.toISOString(),
      notes: r.notes,
    };
  }
}
