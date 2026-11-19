import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { isFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import { unitCounts } from '../analytics/business-metrics';
import { AuditService } from '../auth/audit.service';
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

/** Una ocupación de la competencia más antigua no cuenta (como en el precio). */
const FRESH_DAYS = 180;

/** Quién hace el cambio (para el registro de actividad) y qué locales ve. */
export interface CompetitorActor {
  userId: string | null;
  facilityScope?: FacilityScope;
}

/**
 * Competidores que ve un usuario: los ligados a sus locales y los que no van
 * ligados a ninguno. Con un local elegido, los de ese local y los sin ligar.
 */
export function competitorWhere(
  facilityScope: FacilityScope | undefined,
  facilityId?: string | null,
): Prisma.CompetitorFacilityWhereInput {
  if (facilityId) return { OR: [{ facilityId }, { facilityId: null }] };
  if (facilityScope && facilityScope.length > 0) {
    return { OR: [{ facilityId: { in: facilityScope } }, { facilityId: null }] };
  }
  return {};
}

/** La última comprobación de algo suyo: la revisión o cualquier trastero. */
function lastChecked(
  reviewedAt: Date | null,
  units: { observations: { observedAt: Date }[] }[],
): Date | null {
  let last = reviewedAt;
  for (const u of units) {
    const at = u.observations[0]?.observedAt;
    if (at && (!last || at > last)) last = at;
  }
  return last;
}

@Injectable()
export class CompetitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- locales de la competencia ----

  async listFacilities(
    tenantId: string,
    facilityScope?: FacilityScope,
    facilityId?: string | null,
  ): Promise<CompetitorFacilityDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findMany({
          where: competitorWhere(facilityScope, facilityId),
          orderBy: { createdAt: 'asc' },
          include: {
            facility: { select: { name: true } },
            _count: { select: { units: true } },
            units: {
              select: {
                status: true,
                observations: {
                  orderBy: { observedAt: 'desc' },
                  take: 1,
                  select: { observedAt: true },
                },
              },
            },
          },
        }),
      tenantId,
    );
    return rows.map((r) => {
      const checked = lastChecked(r.lastReviewedAt, r.units);
      return {
        ...this.facilityToDto(r),
        lastReviewedAt: checked?.toISOString() ?? null,
        facilityName: r.facility?.name ?? null,
        unitCount: r._count.units,
        availableCount: r.units.filter((u) => u.status === 'available').length,
      };
    });
  }

  /**
   * Ocupación de mercado: compara mi ocupación física con la de la competencia
   * (inferida de los trasteros fichados con su estado available/occupied). La
   * ocupación de la competencia se pondera por nº de trasteros, no por local
   * (un competidor con 100 trasteros pesa más que uno con 5).
   */
  async getMarketOccupancy(
    tenantId: string,
    facilityScope?: FacilityScope,
    facilityId?: string | null,
  ): Promise<MarketOccupancyDto> {
    const scope = resolveAnalyticsScope(facilityScope ?? null, facilityId ?? undefined);
    const freshCut = Date.now() - FRESH_DAYS * 86_400_000;
    return this.prisma.withTenant(async (tx) => {
      const [counts, competitors] = await Promise.all([
        // La misma ocupación que Analítica: sin locales por abrir ni el inquilino de prueba.
        unitCounts(tx, scope),
        tx.competitorFacility.findMany({
          where: competitorWhere(facilityScope, facilityId),
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            inventoryComplete: true,
            knownTotalUnits: true,
            lastReviewedAt: true,
            units: {
              select: {
                status: true,
                observations: {
                  orderBy: { observedAt: 'desc' },
                  take: 1,
                  select: { observedAt: true },
                },
              },
            },
          },
        }),
      ]);

      // Solo es fiable con el inventario completo y reciente (como el precio).
      // Con un total conocido se estima aparte: los no fichados se dan por
      // ocupados y eso puede inflarla mucho.
      const rows = competitors.map((c) => {
        const fichados = c.units.length;
        const available = c.units.filter((u) => u.status === 'available').length;
        const checked = lastChecked(c.lastReviewedAt, c.units);
        const stale = !checked || checked.getTime() < freshCut;
        const reliable = c.inventoryComplete && fichados > 0 && !stale;
        const estimated =
          !c.inventoryComplete && c.knownTotalUnits && c.knownTotalUnits >= available && !stale
            ? (c.knownTotalUnits - available) / c.knownTotalUnits
            : null;
        return {
          id: c.id,
          name: c.name,
          unitCount: fichados,
          occupiedCount: fichados - available,
          occupancyPct: reliable ? (fichados - available) / fichados : null,
          estimatedOccupancyPct: estimated,
          inventoryComplete: c.inventoryComplete,
          knownTotalUnits: c.knownTotalUnits,
          stale,
        };
      });

      const reliableRows = rows.filter((r) => r.occupancyPct !== null);
      const competitionTotalUnits = reliableRows.reduce((s, r) => s + r.unitCount, 0);
      const competitionOccupiedUnits = reliableRows.reduce((s, r) => s + r.occupiedCount, 0);

      return {
        facilityId: scope.explicit ? (facilityId ?? null) : null,
        myOccupancyPct: counts.total === 0 ? 0 : counts.occupied / counts.total,
        myOccupiedUnits: counts.occupied,
        myTotalUnits: counts.total,
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
    actor: CompetitorActor = { userId: null },
  ): Promise<CompetitorFacilityDto> {
    if (input.facilityId) await this.assertMyFacility(tenantId, input.facilityId, actor);
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
    await this.log(tenantId, actor, 'competitor.created', 'CompetitorFacility', created.id, {
      name: created.name,
    });
    return this.facilityToDto(created);
  }

  async updateFacility(
    tenantId: string,
    id: string,
    input: UpdateCompetitorFacilityInput,
    actor: CompetitorActor = { userId: null },
  ): Promise<CompetitorFacilityDto> {
    const existing = await this.findFacilityOrThrow(tenantId, id, actor.facilityScope);
    if (input.facilityId) await this.assertMyFacility(tenantId, input.facilityId, actor);
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
    await this.log(tenantId, actor, 'competitor.updated', 'CompetitorFacility', id, {
      fields: Object.keys(input),
    });
    return this.facilityToDto(updated);
  }

  async removeFacility(
    tenantId: string,
    id: string,
    actor: CompetitorActor = { userId: null },
  ): Promise<void> {
    await this.findFacilityOrThrow(tenantId, id, actor.facilityScope);
    const removed = await this.prisma.withTenant(
      (tx) => tx.competitorFacility.delete({ where: { id } }),
      tenantId,
    );
    await this.log(tenantId, actor, 'competitor.deleted', 'CompetitorFacility', id, {
      name: removed.name,
    });
  }

  // ---- trasteros de la competencia ----

  async listUnits(
    tenantId: string,
    competitorFacilityId: string,
    facilityScope?: FacilityScope,
  ): Promise<CompetitorUnitDto[]> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId, facilityScope);
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
    actor: CompetitorActor = { userId: null },
  ): Promise<CompetitorUnitDto> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId, actor.facilityScope);
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
    await this.log(tenantId, actor, 'competitor.unit_created', 'CompetitorUnit', created.id, {
      competitorFacilityId,
      areaM2,
      priceMonthly: input.priceMonthly,
    });
    return this.unitToDto(created, created.observations);
  }

  async updateUnit(
    tenantId: string,
    id: string,
    input: UpdateCompetitorUnitInput,
    actor: CompetitorActor = { userId: null },
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
            competitorFacility: { select: { facilityId: true } },
          },
        }),
      tenantId,
    );
    if (!existing || !this.competitorVisible(existing.competitorFacility.facilityId, actor)) {
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
    // Cambiar precio o estado, o decir que se ha comprobado hoy, es una
    // comprobación nueva: queda en el histórico. Corregir la referencia, las
    // notas o las medidas no cambia cuándo se comprobó.
    const nextPrice = input.priceMonthly ?? num(existing.priceMonthly);
    const nextStatus = input.status ?? existing.status;
    const observed =
      input.checked === true ||
      (input.priceMonthly !== undefined && input.priceMonthly !== num(existing.priceMonthly)) ||
      (input.status !== undefined && input.status !== existing.status);
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
            ...(observed ? { lastCheckedAt: new Date() } : {}),
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
    await this.log(tenantId, actor, 'competitor.unit_updated', 'CompetitorUnit', id, {
      fields: Object.keys(input),
      ...(observed ? { priceMonthly: nextPrice, status: nextStatus } : {}),
    });
    return this.unitToDto(updated, updated.observations);
  }

  async removeUnit(
    tenantId: string,
    id: string,
    actor: CompetitorActor = { userId: null },
  ): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnit.findFirst({
          where: { id, tenantId },
          select: {
            id: true,
            areaM2: true,
            competitorFacilityId: true,
            competitorFacility: { select: { facilityId: true } },
          },
        }),
      tenantId,
    );
    if (!existing || !this.competitorVisible(existing.competitorFacility.facilityId, actor)) {
      throw new NotFoundException({ code: 'competitor_unit_not_found', message: 'No encontrado' });
    }
    await this.prisma.withTenant((tx) => tx.competitorUnit.delete({ where: { id } }), tenantId);
    await this.log(tenantId, actor, 'competitor.unit_deleted', 'CompetitorUnit', id, {
      competitorFacilityId: existing.competitorFacilityId,
      areaM2: num(existing.areaM2),
    });
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
    actor: CompetitorActor = { userId: null },
  ): Promise<CompetitorUnitDto[]> {
    await this.findFacilityOrThrow(tenantId, competitorFacilityId, actor.facilityScope);
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
    await this.log(
      tenantId,
      actor,
      'competitor.reviewed',
      'CompetitorFacility',
      competitorFacilityId,
      {
        units: input.units.length,
      },
    );
    return this.listUnits(tenantId, competitorFacilityId, actor.facilityScope);
  }

  /** Histórico completo de comprobaciones de un trastero de la competencia. */
  async unitHistory(
    tenantId: string,
    unitId: string,
    facilityScope?: FacilityScope,
  ): Promise<CompetitorUnitObservationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.competitorUnitObservation.findMany({
          where: {
            competitorUnitId: unitId,
            unit: { tenantId, competitorFacility: competitorWhere(facilityScope) },
          },
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

  /** Un competidor ligado a un local que el usuario no ve, no existe para él. */
  private competitorVisible(facilityId: string | null, actor: CompetitorActor): boolean {
    return (
      !facilityId || !actor.facilityScope || isFacilityAllowed(actor.facilityScope, facilityId)
    );
  }

  /** El local con el que compite tiene que ser del negocio y del alcance del usuario. */
  private async assertMyFacility(
    tenantId: string,
    facilityId: string,
    actor: CompetitorActor,
  ): Promise<void> {
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: facilityId, tenantId, deletedAt: null },
          select: { id: true },
        }),
      tenantId,
    );
    if (!found || !this.competitorVisible(facilityId, actor)) {
      throw new BadRequestException({
        code: 'invalid_facility',
        message: 'El local elegido no existe o no lo puedes ver',
      });
    }
  }

  private async log(
    tenantId: string,
    actor: CompetitorActor,
    action: string,
    entityType: string,
    entityId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId: actor.userId,
      action,
      entityType,
      entityId,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: null,
      userAgent: null,
    });
  }

  private async findFacilityOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: FacilityScope,
  ): Promise<{ id: string; inventoryComplete: boolean }> {
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findFirst({
          where: { id, tenantId, ...competitorWhere(facilityScope) },
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
