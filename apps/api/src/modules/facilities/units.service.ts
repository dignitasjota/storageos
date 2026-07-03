import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import { FacilityFloorsService } from './facility-floors.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Unit, UnitStatus } from '@storageos/database';
import type {
  ChangeUnitStatusInput,
  CreateUnitInput,
  UnitDto,
  UnitStatusHistoryDto,
  UnitStatusValue,
  UpdateUnitInput,
} from '@storageos/shared';

/**
 * Transiciones de estado validas en Fase 2. En Fase 3 (contratos)
 * algunas se activaran automaticamente (occupied <-> available al firmar/
 * cerrar contrato). De momento todas son manuales.
 *
 * Reglas:
 * - `occupied` solo lo pondra el flujo de contratos en Fase 3. Lo bloqueamos
 *   en cambios manuales para no quedar con units ocupadas sin contrato.
 *   `occupied -> available` SI es manual (admin cierra ocupacion sin
 *   contrato registrado).
 */
const ALLOWED_TRANSITIONS: Record<UnitStatusValue, UnitStatusValue[]> = {
  available: ['reserved', 'maintenance', 'blocked'],
  reserved: ['available', 'maintenance', 'blocked'],
  maintenance: ['available', 'blocked'],
  blocked: ['available', 'maintenance'],
  occupied: ['available', 'maintenance', 'blocked'],
};

export interface ListUnitsFilters {
  facilityId?: string;
  floorId?: string;
  unitTypeId?: string;
  status?: UnitStatusValue;
  search?: string;
  limit?: number;
  cursor?: string;
  /** Permisos por local: si está, solo unidades de esos locales. */
  facilityScope?: string[] | null;
}

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly floors: FacilityFloorsService,
    private readonly limits: PlanLimitsService,
  ) {}

  async list(
    tenantId: string,
    filters: ListUnitsFilters,
  ): Promise<{ items: UnitDto[]; nextCursor: string | null }> {
    const where: Prisma.UnitWhereInput = {};
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return { items: [], nextCursor: null }; // local fuera de scope
    if (facFilter) where.facilityId = { in: facFilter };
    if (filters.floorId) where.floorId = filters.floorId;
    if (filters.unitTypeId) where.unitTypeId = filters.unitTypeId;
    if (filters.status) where.status = filters.status as UnitStatus;
    if (filters.search) {
      where.OR = [
        { code: { contains: filters.search, mode: 'insensitive' } },
        { notes: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findMany({
          where,
          orderBy: [{ id: 'asc' }],
          take: limit + 1,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
          include: {
            facility: { select: { name: true } },
            floor: { select: { name: true } },
            unitType: { select: { name: true, color: true } },
          },
        }),
      tenantId,
    );
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map((r) => this.toDto(r)),
      nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
    };
  }

  async detail(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitDto> {
    const row = await this.findOrThrow(tenantId, unitId, facilityScope);
    return this.toDto(row);
  }

  async history(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitStatusHistoryDto[]> {
    await this.findOrThrow(tenantId, unitId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitStatusHistory.findMany({
          where: { unitId },
          orderBy: { occurredAt: 'desc' },
          include: { changedBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      previousStatus: r.previousStatus as UnitStatusValue,
      newStatus: r.newStatus as UnitStatusValue,
      changedByUserId: r.changedByUserId,
      changedByName: r.changedBy?.fullName ?? null,
      reason: r.reason,
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateUnitInput;
    meta: RequestMeta;
  }): Promise<UnitDto> {
    const { tenantId, input } = args;
    // Validar facility, unit_type y resolver floor (crear default si no hay).
    const created = await this.prisma.withTenant(async (tx) => {
      // Enforcement del límite de trasteros (+ add-ons) DENTRO de la tx, con un
      // lock por tenant para que dos altas concurrentes no se salten el tope.
      await this.limits.lockForCreate(tx, tenantId, 'units');
      const currentUnits = await tx.unit.count();
      await this.limits.assertCanCreate(tenantId, 'units', currentUnits);
      const facility = await tx.facility.findFirst({
        where: { id: input.facilityId, deletedAt: null },
      });
      if (!facility) {
        throw new NotFoundException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
      const unitType = await tx.unitType.findUnique({ where: { id: input.unitTypeId } });
      if (!unitType) {
        throw new NotFoundException({
          code: 'unit_type_not_found',
          message: 'Tipo no encontrado',
        });
      }

      let floorId = input.floorId;
      if (floorId) {
        const floor = await tx.facilityFloor.findFirst({
          where: { id: floorId, facilityId: input.facilityId },
        });
        if (!floor) {
          throw new NotFoundException({
            code: 'floor_not_in_facility',
            message: 'La planta no pertenece a este local',
          });
        }
      } else {
        const ensured = await this.floors.ensureDefaultFloor(tx, input.facilityId);
        floorId = ensured.id;
      }

      try {
        return await tx.unit.create({
          data: {
            tenantId,
            facilityId: input.facilityId,
            floorId,
            unitTypeId: input.unitTypeId,
            code: input.code.trim(),
            widthM: input.widthM,
            depthM: input.depthM,
            heightM: input.heightM,
            basePriceMonthly: input.basePriceMonthly ?? Number(unitType.defaultPriceMonthly),
            notes: input.notes?.trim() || null,
          },
          include: {
            facility: { select: { name: true } },
            floor: { select: { name: true } },
            unitType: { select: { name: true, color: true } },
          },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'unit_code_taken',
            message: 'Ya existe un trastero con ese codigo en este local',
          });
        }
        throw err;
      }
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'unit.created',
      entityType: 'Unit',
      entityId: created.id,
      changes: { code: created.code, facilityId: created.facilityId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    input: UpdateUnitInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<UnitDto> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    const data: Prisma.UnitUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (args.input.floorId !== undefined) {
      // Validar que la floor pertenece a la misma facility.
      const floor = await this.prisma.withTenant(
        (tx) => tx.facilityFloor.findUnique({ where: { id: args.input.floorId! } }),
        args.tenantId,
      );
      if (!floor || floor.facilityId !== existing.facilityId) {
        throw new BadRequestException({
          code: 'floor_not_in_facility',
          message: 'La planta no pertenece a este local',
        });
      }
      data.floor = { connect: { id: args.input.floorId } };
      changes.floorId = args.input.floorId;
    }
    if (args.input.unitTypeId !== undefined) {
      data.unitType = { connect: { id: args.input.unitTypeId } };
      changes.unitTypeId = args.input.unitTypeId;
    }
    if (args.input.code !== undefined) {
      data.code = args.input.code.trim();
      changes.code = data.code;
    }
    if (args.input.widthM !== undefined) {
      data.widthM = args.input.widthM;
      changes.widthM = args.input.widthM;
    }
    if (args.input.depthM !== undefined) {
      data.depthM = args.input.depthM;
      changes.depthM = args.input.depthM;
    }
    if (args.input.heightM !== undefined) {
      data.heightM = args.input.heightM;
      changes.heightM = args.input.heightM;
    }
    if (args.input.basePriceMonthly !== undefined) {
      data.basePriceMonthly = args.input.basePriceMonthly;
      changes.basePriceMonthly = args.input.basePriceMonthly;
    }
    if (args.input.notes !== undefined) {
      data.notes = args.input.notes.trim() || null;
      changes.notes = data.notes;
    }

    let updated;
    try {
      updated = await this.prisma.withTenant(
        (tx) =>
          tx.unit.update({
            where: { id: args.unitId },
            data,
            include: {
              facility: { select: { name: true } },
              floor: { select: { name: true } },
              unitType: { select: { name: true, color: true } },
            },
          }),
        args.tenantId,
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'unit_code_taken',
          message: 'Ya existe un trastero con ese codigo en este local',
        });
      }
      throw err;
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.updated',
      entityType: 'Unit',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async delete(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<void> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    if (existing.status === 'occupied') {
      throw new ConflictException({
        code: 'unit_occupied',
        message: 'No se puede borrar un trastero ocupado',
      });
    }
    await this.prisma.withTenant(
      (tx) => tx.unit.delete({ where: { id: args.unitId } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.deleted',
      entityType: 'Unit',
      entityId: args.unitId,
      changes: { code: existing.code },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  async changeStatus(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    input: ChangeUnitStatusInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<UnitDto> {
    const existing = await this.findOrThrow(args.tenantId, args.unitId, args.facilityScope);
    const from = existing.status as UnitStatusValue;
    const to = args.input.status;
    if (from === to) return this.toDto(existing);
    if (to === 'occupied') {
      throw new BadRequestException({
        code: 'occupied_via_contract_only',
        message: 'El estado "occupied" se asigna automaticamente al firmar un contrato',
      });
    }
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new BadRequestException({
        code: 'invalid_status_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.unit.update({
        where: { id: args.unitId },
        data: { status: to as UnitStatus },
        include: {
          facility: { select: { name: true } },
          floor: { select: { name: true } },
          unitType: { select: { name: true, color: true } },
        },
      });
      await tx.unitStatusHistory.create({
        data: {
          tenantId: args.tenantId,
          unitId: args.unitId,
          previousStatus: from as UnitStatus,
          newStatus: to as UnitStatus,
          changedByUserId: args.userId,
          reason: args.input.reason?.trim() || null,
        },
      });
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.status_changed',
      entityType: 'Unit',
      entityId: args.unitId,
      changes: { from, to, reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, unitId: string, facilityScope?: string[] | null) {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findUnique({
          where: { id: unitId },
          include: {
            facility: { select: { name: true } },
            floor: { select: { name: true } },
            unitType: { select: { name: true, color: true } },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    assertFacilityAllowed(facilityScope, row.facilityId);
    return row;
  }

  private toDto(
    row: Unit & {
      facility: { name: string };
      floor: { name: string };
      unitType: { name: string; color: string };
    },
  ): UnitDto {
    return {
      id: row.id,
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      floorId: row.floorId,
      floorName: row.floor.name,
      unitTypeId: row.unitTypeId,
      unitTypeName: row.unitType.name,
      unitTypeColor: row.unitType.color,
      code: row.code,
      widthM: Number(row.widthM),
      depthM: Number(row.depthM),
      heightM: Number(row.heightM),
      areaM2: row.areaM2 !== null && row.areaM2 !== undefined ? Number(row.areaM2) : 0,
      volumeM3: row.volumeM3 !== null && row.volumeM3 !== undefined ? Number(row.volumeM3) : 0,
      status: row.status as UnitStatusValue,
      basePriceMonthly: Number(row.basePriceMonthly),
      planX: row.planX !== null && row.planX !== undefined ? Number(row.planX) : null,
      planY: row.planY !== null && row.planY !== undefined ? Number(row.planY) : null,
      planWidth:
        row.planWidth !== null && row.planWidth !== undefined ? Number(row.planWidth) : null,
      planHeight:
        row.planHeight !== null && row.planHeight !== undefined ? Number(row.planHeight) : null,
      planShape: (row.planShape as Record<string, unknown> | null) ?? null,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
