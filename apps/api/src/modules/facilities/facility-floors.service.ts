import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { FacilityFloor, Prisma } from '@storageos/database';
import type {
  CreateFloorInput,
  FacilityFloorDto,
  UpdateFloorInput,
  UpdateFloorPlanInput,
  UpdateUnitsLayoutInput,
} from '@storageos/shared';

const DEFAULT_FLOOR_NAME = 'Planta principal';

@Injectable()
export class FacilityFloorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findOrThrow(tenantId: string, floorId: string): Promise<FacilityFloor> {
    const floor = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.findUnique({ where: { id: floorId } }),
      tenantId,
    );
    if (!floor) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    return floor;
  }

  async list(tenantId: string, facilityId: string): Promise<FacilityFloorDto[]> {
    await this.assertFacility(tenantId, facilityId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.facilityFloor.findMany({
          where: { facilityId },
          orderBy: [{ floorNumber: 'asc' }, { name: 'asc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Devuelve la "default floor" del facility creandola si no existe.
   * Garantiza que cada facility tenga al menos una floor para que las
   * units puedan apuntar a alguna.
   */
  async ensureDefaultFloor(
    tx: Prisma.TransactionClient,
    facilityId: string,
  ): Promise<FacilityFloor> {
    const existing = await tx.facilityFloor.findFirst({
      where: { facilityId, isDefault: true },
    });
    if (existing) return existing;
    // Quizas el usuario ya creo una floor manual; usamos la primera.
    const any = await tx.facilityFloor.findFirst({
      where: { facilityId },
      orderBy: { floorNumber: 'asc' },
    });
    if (any) return any;
    return tx.facilityFloor.create({
      data: {
        facilityId,
        name: DEFAULT_FLOOR_NAME,
        floorNumber: 0,
        isDefault: true,
      },
    });
  }

  async create(
    tenantId: string,
    userId: string,
    facilityId: string,
    input: CreateFloorInput,
    meta: RequestMeta,
  ): Promise<FacilityFloorDto> {
    await this.assertFacility(tenantId, facilityId);
    const floor = await this.prisma.withTenant(
      (tx) =>
        tx.facilityFloor.create({
          data: {
            facilityId,
            name: input.name.trim(),
            floorNumber: input.floorNumber ?? 0,
            isDefault: false,
          },
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.created',
      entityType: 'FacilityFloor',
      entityId: floor.id,
      changes: { facilityId, name: floor.name },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDto(floor);
  }

  async update(
    tenantId: string,
    userId: string,
    floorId: string,
    input: UpdateFloorInput,
    meta: RequestMeta,
  ): Promise<FacilityFloorDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.findUnique({ where: { id: floorId } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    const data: Prisma.FacilityFloorUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.floorNumber !== undefined) data.floorNumber = input.floorNumber;
    const updated = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.update({ where: { id: floorId }, data }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.updated',
      entityType: 'FacilityFloor',
      entityId: floorId,
      changes: { ...data } as unknown as Prisma.InputJsonValue,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async delete(
    tenantId: string,
    userId: string,
    floorId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.facilityFloor.findUnique({
          where: { id: floorId },
          include: { _count: { select: { units: true } } },
        }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    if ((existing._count?.units ?? 0) > 0) {
      throw new ConflictException({
        code: 'floor_has_units',
        message: 'No se puede borrar una planta con trasteros asignados',
      });
    }
    if (existing.isDefault) {
      throw new ConflictException({
        code: 'floor_is_default',
        message: 'No se puede borrar la planta por defecto',
      });
    }
    await this.prisma.withTenant(
      (tx) => tx.facilityFloor.delete({ where: { id: floorId } }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.deleted',
      entityType: 'FacilityFloor',
      entityId: floorId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  async setPlan(
    tenantId: string,
    userId: string,
    floorId: string,
    input: UpdateFloorPlanInput,
    meta: RequestMeta,
  ): Promise<FacilityFloorDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.findUnique({ where: { id: floorId } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.facilityFloor.update({
          where: { id: floorId },
          data: {
            planImageUrl: input.planImageUrl,
            planWidthPx: input.planWidthPx,
            planHeightPx: input.planHeightPx,
          },
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.plan_uploaded',
      entityType: 'FacilityFloor',
      entityId: floorId,
      changes: {
        widthPx: input.planWidthPx,
        heightPx: input.planHeightPx,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async updateUnitsLayout(
    tenantId: string,
    userId: string,
    floorId: string,
    input: UpdateUnitsLayoutInput,
    meta: RequestMeta,
  ): Promise<{ updated: number }> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.findUnique({ where: { id: floorId } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    const ids = input.units.map((u) => u.id);
    const owned = await this.prisma.withTenant(
      (tx) => tx.unit.findMany({ where: { id: { in: ids }, floorId } }),
      tenantId,
    );
    if (owned.length !== ids.length) {
      throw new NotFoundException({
        code: 'unit_not_in_floor',
        message: 'Alguna unit no pertenece a esta planta',
      });
    }

    await this.prisma.withTenant(
      (tx) =>
        Promise.all(
          input.units.map((u) =>
            tx.unit.update({
              where: { id: u.id },
              data: {
                planX: u.planX,
                planY: u.planY,
                planWidth: u.planWidth,
                planHeight: u.planHeight,
              },
            }),
          ),
        ),
      tenantId,
    );

    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.layout_updated',
      entityType: 'FacilityFloor',
      entityId: floorId,
      changes: { unitsCount: input.units.length },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { updated: input.units.length };
  }

  private async assertFacility(tenantId: string, facilityId: string): Promise<void> {
    const f = await this.prisma.withTenant(
      (tx) => tx.facility.findFirst({ where: { id: facilityId, deletedAt: null } }),
      tenantId,
    );
    if (!f) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
  }

  private toDto(f: FacilityFloor): FacilityFloorDto {
    return {
      id: f.id,
      facilityId: f.facilityId,
      name: f.name,
      floorNumber: f.floorNumber,
      planImageUrl: f.planImageUrl,
      planWidthPx: f.planWidthPx,
      planHeightPx: f.planHeightPx,
      isDefault: f.isDefault,
      createdAt: f.createdAt.toISOString(),
    };
  }
}
