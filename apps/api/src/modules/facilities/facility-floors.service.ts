import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

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

/** Tamaño máximo de un plano (`RequestPlanUploadSchema`). */
const FLOOR_PLAN_MAX_BYTES = 5 * 1024 * 1024;

@Injectable()
export class FacilityFloorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  /** La planta de un local que sigue existiendo. */
  async findOrThrow(tenantId: string, floorId: string): Promise<FacilityFloor> {
    const floor = await this.prisma.withTenant(
      (tx) => tx.facilityFloor.findFirst({ where: { id: floorId, facility: { deletedAt: null } } }),
      tenantId,
    );
    if (!floor) {
      throw new NotFoundException({ code: 'floor_not_found', message: 'Planta no encontrada' });
    }
    return floor;
  }

  /** Dos plantas con el mismo nombre no se distinguen en los desplegables. */
  private async assertNameFree(
    tx: Prisma.TransactionClient,
    facilityId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await tx.facilityFloor.findFirst({
      where: {
        facilityId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'floor_name_taken',
        message: `Este local ya tiene una planta llamada «${name}».`,
      });
    }
  }

  private async deletePlanFile(planImageUrl: string | null): Promise<void> {
    const key = planImageUrl ? this.files.keyFromPublicUrl('plans', planImageUrl) : null;
    if (key) await this.files.deleteObjects('plans', [key]).catch(() => undefined);
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
    return Promise.all(rows.map((r) => this.toDto(r)));
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
    const floor = await this.prisma.withTenant(async (tx) => {
      await this.assertNameFree(tx, facilityId, input.name.trim());
      return tx.facilityFloor.create({
        data: {
          facilityId,
          name: input.name.trim(),
          floorNumber: input.floorNumber ?? 0,
          isDefault: false,
        },
      });
    }, tenantId);
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
    const existing = await this.findOrThrow(tenantId, floorId);
    const data: Prisma.FacilityFloorUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.floorNumber !== undefined) data.floorNumber = input.floorNumber;
    const updated = await this.prisma.withTenant(async (tx) => {
      const name = input.name?.trim();
      if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
        await this.assertNameFree(tx, existing.facilityId, name, floorId);
      }
      return tx.facilityFloor.update({ where: { id: floorId }, data });
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.updated',
      entityType: 'FacilityFloor',
      entityId: floorId,
      changes: { ...data, facilityId: existing.facilityId } as unknown as Prisma.InputJsonValue,
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
        tx.facilityFloor.findFirst({
          where: { id: floorId, facility: { deletedAt: null } },
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
        message:
          'Esta planta tiene trasteros. En Trasteros puedes seleccionarlos y moverlos a otra planta de una vez.',
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
    await this.deletePlanFile(existing.planImageUrl);
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.deleted',
      entityType: 'FacilityFloor',
      entityId: floorId,
      changes: { facilityId: existing.facilityId, name: existing.name },
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
    const existing = await this.findOrThrow(tenantId, floorId);
    // Seguridad: `planImageUrl` llegaba SIN validar en absoluto (a diferencia
    // de `setImages`/`setCover`, que sí comprueban el prefijo) — cualquier
    // URL era aceptada, incluida una externa ajena al bucket `plans` del
    // tenant. Se exige que apunte a la key que generó `requestPlanUploadUrl`
    // para ESTA planta + que los bytes reales sean uno de los tipos
    // permitidos (el `Content-Type` declarado al pedir la URL no está
    // protegido por la firma, ver `FilesService.assertObjectMimeType`).
    const bucketBase = this.files.buildPublicUrl('plans', '');
    const expectedPrefix = `${bucketBase}${tenantId}/${existing.facilityId}/floors/${floorId}-`;
    if (!input.planImageUrl.startsWith(expectedPrefix)) {
      throw new BadRequestException({
        code: 'invalid_plan_url',
        message: 'La URL del plano no es válida',
      });
    }
    const key = input.planImageUrl.slice(bucketBase.length);
    await this.files.assertObjectMimeType(
      'plans',
      key,
      ['image/jpeg', 'image/png', 'image/webp'],
      FLOOR_PLAN_MAX_BYTES,
      { mustExist: true },
    );
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
    // El plano anterior ya no lo usa nadie.
    if (existing.planImageUrl !== input.planImageUrl) {
      await this.deletePlanFile(existing.planImageUrl);
    }
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

  /** Quita el plano de la planta. La posición de los trasteros se conserva. */
  async removePlan(
    tenantId: string,
    userId: string,
    floorId: string,
    meta: RequestMeta,
  ): Promise<FacilityFloorDto> {
    const existing = await this.findOrThrow(tenantId, floorId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.facilityFloor.update({
          where: { id: floorId },
          data: { planImageUrl: null, planWidthPx: null, planHeightPx: null },
        }),
      tenantId,
    );
    await this.deletePlanFile(existing.planImageUrl);
    await this.audit.write({
      tenantId,
      userId,
      action: 'floor.plan_removed',
      entityType: 'FacilityFloor',
      entityId: floorId,
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
    await this.findOrThrow(tenantId, floorId);
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

  /**
   * El bucket `plans` es PRIVADO (como `uploads`/`invoices`) — `planImageUrl`
   * se guarda en BD con la forma de `buildPublicUrl('plans', key)`, que no
   * sirve para un `<img src>` directo (403 anónimo). Se resuelve aquí a una
   * URL GET firmada (mismo patrón que `presignFromPublicUrl` usa para PDFs
   * de contrato/factura), así el resto del código (frontend, `setPlan`'s
   * validación de prefijo) sigue trabajando con la forma "pública" sin tocar.
   */
  private async toDto(f: FacilityFloor): Promise<FacilityFloorDto> {
    const planImageUrl = f.planImageUrl
      ? ((await this.files.presignFromPublicUrl('plans', f.planImageUrl)) ?? f.planImageUrl)
      : null;
    return {
      id: f.id,
      facilityId: f.facilityId,
      name: f.name,
      floorNumber: f.floorNumber,
      planImageUrl,
      planWidthPx: f.planWidthPx,
      planHeightPx: f.planHeightPx,
      isDefault: f.isDefault,
      createdAt: f.createdAt.toISOString(),
    };
  }
}
