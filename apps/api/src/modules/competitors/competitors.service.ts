import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CompetitorContactMethod,
  CompetitorFacilityDto,
  CompetitorFeature,
  CompetitorUnitDto,
  CompetitorUnitHistorySummaryDto,
  CompetitorUnitObservationDto,
  CompetitorUnitStatus,
  CreateCompetitorFacilityInput,
  CreateCompetitorUnitInput,
  MarketOccupancyDto,
  ReviewCompetitorInput,
  UpdateCompetitorFacilityInput,
  UpdateCompetitorUnitInput,
} from '@storageos/shared';

const num = (d: { toString(): string }): number => Number(d.toString());
const round2 = (n: number): number => Math.round(n * 100) / 100;
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
      ...this.facilityToDto(r),
      facilityName: r.facility?.name ?? null,
      unitCount: r._count.units,
      availableCount: r.units.filter((u) => u.status === 'available').length,
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
          select: {
            id: true,
            name: true,
            inventoryComplete: true,
            knownTotalUnits: true,
            units: { select: { status: true } },
          },
        }),
      ]);

      // La ocupación de un competidor solo es fiable si conocemos su total:
      // con el inventario completo (todos fichados) o con un total conocido
      // (los no fichados se dan por ocupados). Si no, no se sabe → se excluye.
      const rows = competitors.map((c) => {
        const fichados = c.units.length;
        const available = c.units.filter((u) => u.status === 'available').length;
        let unitCount = fichados;
        let occupiedCount = fichados - available;
        let reliable = c.inventoryComplete && fichados > 0;
        if (!c.inventoryComplete && c.knownTotalUnits && c.knownTotalUnits >= available) {
          unitCount = c.knownTotalUnits;
          occupiedCount = c.knownTotalUnits - available;
          reliable = true;
        }
        return {
          id: c.id,
          name: c.name,
          unitCount,
          occupiedCount,
          occupancyPct: reliable && unitCount > 0 ? occupiedCount / unitCount : null,
          inventoryComplete: c.inventoryComplete,
          knownTotalUnits: c.knownTotalUnits,
        };
      });

      const reliableRows = rows.filter((r) => r.occupancyPct !== null);
      const competitionTotalUnits = reliableRows.reduce((s, r) => s + r.unitCount, 0);
      const competitionOccupiedUnits = reliableRows.reduce((s, r) => s + r.occupiedCount, 0);

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
            priceIncludesVat: input.priceIncludesVat,
            notes: cleanText(input.notes),
            ...this.facilityExtraData(input),
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
    const existing = await this.findFacilityOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.zone !== undefined ? { zone: cleanText(input.zone) } : {}),
            ...(input.facilityId !== undefined ? { facilityId: input.facilityId ?? null } : {}),
            ...(input.priceIncludesVat !== undefined
              ? { priceIncludesVat: input.priceIncludesVat }
              : {}),
            ...(input.notes !== undefined ? { notes: cleanText(input.notes) } : {}),
            ...this.facilityExtraData(input, existing.inventoryComplete),
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
          include: { observations: { orderBy: { observedAt: 'asc' } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.unitToDto(r, r.observations));
  }

  async createUnit(
    tenantId: string,
    competitorFacilityId: string,
    input: CreateCompetitorUnitInput,
  ): Promise<CompetitorUnitDto> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId);
    // Si hay ancho y fondo, el área se calcula; si no, se usa la indicada (el
    // refine del schema garantiza que llega una de las dos).
    const areaM2 =
      input.widthM != null && input.depthM != null
        ? round2(input.widthM * input.depthM)
        : (input.areaM2 as number);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.create({
          data: {
            tenantId,
            competitorFacilityId,
            areaM2,
            widthM: input.widthM ?? null,
            depthM: input.depthM ?? null,
            heightM: input.heightM ?? null,
            priceMonthly: input.priceMonthly,
            status: input.status,
            notes: cleanText(input.notes),
            externalRef: cleanText(input.externalRef),
            lastCheckedAt: new Date(),
            observations: {
              create: { tenantId, priceMonthly: input.priceMonthly, status: input.status },
            },
          },
          include: { observations: true },
        }),
      tenantId,
    );
    return this.unitToDto(created, created.observations);
  }

  async updateUnit(
    tenantId: string,
    id: string,
    input: UpdateCompetitorUnitInput,
  ): Promise<CompetitorUnitDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.findFirst({
          where: { id, tenantId },
          select: {
            id: true,
            widthM: true,
            depthM: true,
            priceMonthly: true,
            status: true,
          },
        }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'competitor_unit_not_found', message: 'No encontrado' });
    }
    // Recalcula el área si el resultado de las medidas (nuevas o conservadas) da
    // ancho y fondo; si no hay medidas, usa el área indicada.
    const nextWidth =
      input.widthM !== undefined
        ? input.widthM
        : existing.widthM != null
          ? num(existing.widthM)
          : null;
    const nextDepth =
      input.depthM !== undefined
        ? input.depthM
        : existing.depthM != null
          ? num(existing.depthM)
          : null;
    const dimsTouched = input.widthM !== undefined || input.depthM !== undefined;
    const areaUpdate: { areaM2?: number } =
      dimsTouched && nextWidth != null && nextDepth != null
        ? { areaM2: round2(nextWidth * nextDepth) }
        : input.areaM2 !== undefined
          ? { areaM2: input.areaM2 }
          : {};
    // Cambiar precio o estado es una comprobación nueva: queda en el histórico.
    const nextPrice = input.priceMonthly ?? num(existing.priceMonthly);
    const nextStatus = input.status ?? existing.status;
    const observed =
      (input.priceMonthly !== undefined && input.priceMonthly !== num(existing.priceMonthly)) ||
      (input.status !== undefined && input.status !== existing.status);
    const touchesPrice = input.priceMonthly !== undefined || observed;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.update({
          where: { id },
          data: {
            ...areaUpdate,
            ...(input.widthM !== undefined ? { widthM: input.widthM } : {}),
            ...(input.depthM !== undefined ? { depthM: input.depthM } : {}),
            ...(input.heightM !== undefined ? { heightM: input.heightM } : {}),
            ...(input.priceMonthly !== undefined ? { priceMonthly: input.priceMonthly } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: cleanText(input.notes) } : {}),
            ...(input.externalRef !== undefined
              ? { externalRef: cleanText(input.externalRef) }
              : {}),
            ...(touchesPrice ? { lastCheckedAt: new Date() } : {}),
            ...(observed
              ? {
                  observations: {
                    create: { tenantId, priceMonthly: nextPrice, status: nextStatus },
                  },
                }
              : {}),
          },
          include: { observations: { orderBy: { observedAt: 'asc' } } },
        }),
      tenantId,
    );
    return this.unitToDto(updated, updated.observations);
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

  /**
   * Revisión de un competidor: el precio y el estado de HOY de cada trastero.
   * Todos quedan comprobados hoy (aunque no cambien) y cada uno suma una
   * observación a su histórico.
   */
  async review(
    tenantId: string,
    competitorFacilityId: string,
    input: ReviewCompetitorInput,
  ): Promise<CompetitorUnitDto[]> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId);
    const now = new Date();
    await this.prisma.withTenant(async (tx) => {
      const ids = input.units.map((u) => u.id);
      const owned = await tx.competitorUnit.findMany({
        where: { id: { in: ids }, competitorFacilityId },
        select: { id: true },
      });
      if (owned.length !== new Set(ids).size) {
        throw new NotFoundException({
          code: 'competitor_unit_not_found',
          message: 'Algún trastero no es de este competidor',
        });
      }
      for (const u of input.units) {
        await tx.competitorUnit.update({
          where: { id: u.id },
          data: {
            priceMonthly: u.priceMonthly,
            status: u.status,
            lastCheckedAt: now,
            observations: {
              create: {
                tenantId,
                observedAt: now,
                priceMonthly: u.priceMonthly,
                status: u.status,
              },
            },
          },
        });
      }
      await tx.competitorFacility.update({
        where: { id: competitorFacilityId },
        data: { lastReviewedAt: now },
      });
    }, tenantId);
    return this.listUnits(tenantId, competitorFacilityId);
  }

  /** Histórico completo de comprobaciones de un trastero de la competencia. */
  async unitHistory(tenantId: string, unitId: string): Promise<CompetitorUnitObservationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnitObservation.findMany({
          where: { competitorUnitId: unitId, unit: { tenantId } },
          orderBy: { observedAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      observedAt: r.observedAt.toISOString(),
      priceMonthly: num(r.priceMonthly),
      status: r.status as CompetitorUnitStatus,
    }));
  }

  // ---- helpers ----

  private async findFacilityOrThrow(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; inventoryComplete: boolean }> {
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findFirst({
          where: { id, tenantId },
          select: { id: true, inventoryComplete: true },
        }),
      tenantId,
    );
    if (!found) {
      throw new NotFoundException({
        code: 'competitor_facility_not_found',
        message: 'Local de la competencia no encontrado',
      });
    }
    return found;
  }

  /** Campos de contacto, costes, características e inventario (alta y edición). */
  private facilityExtraData(
    input: UpdateCompetitorFacilityInput,
    wasComplete = false,
  ): Omit<Partial<Prisma.CompetitorFacilityUncheckedCreateInput>, 'tenantId' | 'name'> {
    const data: Record<string, unknown> = {};
    if (input.phone !== undefined) data.phone = cleanText(input.phone);
    if (input.website !== undefined) data.website = cleanText(input.website);
    if (input.address !== undefined) data.address = cleanText(input.address);
    if (input.contactMethod !== undefined) data.contactMethod = input.contactMethod;
    if (input.contactNotes !== undefined) data.contactNotes = cleanText(input.contactNotes);
    if (input.distanceKm !== undefined) data.distanceKm = input.distanceKm;
    if (input.knownTotalUnits !== undefined) data.knownTotalUnits = input.knownTotalUnits;
    if (input.currentPromotion !== undefined)
      data.currentPromotion = cleanText(input.currentPromotion);
    if (input.promoFreeMonths !== undefined) data.promoFreeMonths = input.promoFreeMonths;
    if (input.promoDiscountPct !== undefined) data.promoDiscountPct = input.promoDiscountPct;
    if (input.promoDiscountMonths !== undefined)
      data.promoDiscountMonths = input.promoDiscountMonths;
    if (input.depositAmount !== undefined) data.depositAmount = input.depositAmount;
    if (input.setupFee !== undefined) data.setupFee = input.setupFee;
    if (input.mandatoryInsuranceMonthly !== undefined)
      data.mandatoryInsuranceMonthly = input.mandatoryInsuranceMonthly;
    if (input.features !== undefined) data.features = [...new Set(input.features)];
    if (input.inventoryComplete !== undefined) {
      data.inventoryComplete = input.inventoryComplete;
      // La fecha marca cuándo se dio por completo (se conserva si ya lo estaba).
      if (input.inventoryComplete && !wasComplete) data.inventoryCompletedAt = new Date();
      if (!input.inventoryComplete) data.inventoryCompletedAt = null;
    }
    return data as Omit<
      Partial<Prisma.CompetitorFacilityUncheckedCreateInput>,
      'tenantId' | 'name'
    >;
  }

  private facilityToDto(r: {
    id: string;
    name: string;
    zone: string | null;
    facilityId: string | null;
    priceIncludesVat: boolean;
    notes: string | null;
    phone: string | null;
    website: string | null;
    address: string | null;
    contactMethod: string | null;
    contactNotes: string | null;
    distanceKm: { toString(): string } | null;
    inventoryComplete: boolean;
    inventoryCompletedAt: Date | null;
    knownTotalUnits: number | null;
    currentPromotion: string | null;
    promoFreeMonths: number | null;
    promoDiscountPct: number | null;
    promoDiscountMonths: number | null;
    depositAmount: { toString(): string } | null;
    setupFee: { toString(): string } | null;
    mandatoryInsuranceMonthly: { toString(): string } | null;
    features: string[];
    lastReviewedAt: Date | null;
    createdAt: Date;
  }): CompetitorFacilityDto {
    const opt = (d: { toString(): string } | null) => (d != null ? num(d) : null);
    return {
      id: r.id,
      name: r.name,
      zone: r.zone,
      facilityId: r.facilityId,
      facilityName: null,
      priceIncludesVat: r.priceIncludesVat,
      notes: r.notes,
      phone: r.phone,
      website: r.website,
      address: r.address,
      contactMethod: r.contactMethod as CompetitorContactMethod | null,
      contactNotes: r.contactNotes,
      distanceKm: opt(r.distanceKm),
      inventoryComplete: r.inventoryComplete,
      inventoryCompletedAt: r.inventoryCompletedAt?.toISOString() ?? null,
      knownTotalUnits: r.knownTotalUnits,
      currentPromotion: r.currentPromotion,
      promoFreeMonths: r.promoFreeMonths,
      promoDiscountPct: r.promoDiscountPct,
      promoDiscountMonths: r.promoDiscountMonths,
      depositAmount: opt(r.depositAmount),
      setupFee: opt(r.setupFee),
      mandatoryInsuranceMonthly: opt(r.mandatoryInsuranceMonthly),
      features: r.features as CompetitorFeature[],
      lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
      unitCount: 0,
      availableCount: 0,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private unitToDto(
    r: {
      id: string;
      competitorFacilityId: string;
      areaM2: { toString(): string };
      widthM: { toString(): string } | null;
      depthM: { toString(): string } | null;
      heightM: { toString(): string } | null;
      priceMonthly: { toString(): string };
      status: string;
      lastCheckedAt: Date;
      notes: string | null;
      externalRef: string | null;
    },
    observations: { observedAt: Date; priceMonthly: { toString(): string }; status: string }[],
  ): CompetitorUnitDto {
    return {
      id: r.id,
      competitorFacilityId: r.competitorFacilityId,
      areaM2: num(r.areaM2),
      widthM: r.widthM != null ? num(r.widthM) : null,
      depthM: r.depthM != null ? num(r.depthM) : null,
      heightM: r.heightM != null ? num(r.heightM) : null,
      priceMonthly: num(r.priceMonthly),
      status: r.status as CompetitorUnitStatus,
      lastCheckedAt: r.lastCheckedAt.toISOString(),
      notes: r.notes,
      externalRef: r.externalRef,
      history: summarizeObservations(observations),
    };
  }
}

/**
 * Resumen del histórico (observaciones en orden cronológico): variación de
 * precio, desde cuándo está en su estado actual y cuántas veces se alquiló.
 */
export function summarizeObservations(
  obs: { observedAt: Date; priceMonthly: { toString(): string }; status: string }[],
): CompetitorUnitHistorySummaryDto {
  if (obs.length === 0) {
    return {
      observations: 0,
      firstObservedAt: null,
      firstPrice: null,
      priceChangePct: null,
      inCurrentStatusSince: null,
      timesRented: 0,
    };
  }
  const first = obs[0]!;
  const last = obs[obs.length - 1]!;
  const firstPrice = num(first.priceMonthly);
  const lastPrice = num(last.priceMonthly);
  let timesRented = 0;
  for (let i = 1; i < obs.length; i++) {
    if (obs[i - 1]!.status === 'available' && obs[i]!.status === 'occupied') timesRented += 1;
  }
  let since = last.observedAt;
  for (let i = obs.length - 1; i >= 0 && obs[i]!.status === last.status; i--) {
    since = obs[i]!.observedAt;
  }
  return {
    observations: obs.length,
    firstObservedAt: first.observedAt.toISOString(),
    firstPrice,
    priceChangePct: firstPrice > 0 ? round2(((lastPrice - firstPrice) / firstPrice) * 100) : null,
    inCurrentStatusSince: since.toISOString(),
    timesRented,
  };
}
