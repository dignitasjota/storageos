import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, UnitType } from '@storageos/database';
import type { CreateUnitTypeInput, UnitTypeDto, UpdateUnitTypeInput } from '@storageos/shared';

type UnitTypeWithCount = UnitType & { _count?: { units: number } };

interface CreateArgs {
  tenantId: string;
  userId: string;
  input: CreateUnitTypeInput;
  meta: RequestMeta;
}

interface UpdateArgs {
  tenantId: string;
  userId: string;
  unitTypeId: string;
  input: UpdateUnitTypeInput;
  meta: RequestMeta;
}

interface DeleteArgs {
  tenantId: string;
  userId: string;
  unitTypeId: string;
  meta: RequestMeta;
}

@Injectable()
export class UnitTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<UnitTypeDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitType.findMany({
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
          include: { _count: { select: { units: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: CreateArgs): Promise<UnitTypeDto> {
    const data: Prisma.UnitTypeUncheckedCreateInput = {
      tenantId: args.tenantId,
      name: args.input.name.trim(),
      description: args.input.description?.trim() || null,
      defaultPriceMonthly: args.input.defaultPriceMonthly,
      defaultDepositAmount: args.input.defaultDepositAmount ?? 0,
      color: args.input.color,
      features: args.input.features as Prisma.InputJsonValue,
    };
    let created: UnitType;
    try {
      created = await this.prisma.withTenant((tx) => tx.unitType.create({ data }), args.tenantId);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'unit_type_name_taken',
          message: 'Ya existe un tipo con ese nombre',
        });
      }
      throw err;
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit_type.created',
      entityType: 'UnitType',
      entityId: created.id,
      changes: { name: created.name, color: created.color },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto({ ...created, _count: { units: 0 } });
  }

  async update(args: UpdateArgs): Promise<UnitTypeDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.unitType.findUnique({ where: { id: args.unitTypeId } }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'unit_type_not_found', message: 'Tipo no encontrado' });
    }
    const data: Prisma.UnitTypeUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (args.input.name !== undefined) {
      data.name = args.input.name.trim();
      changes.name = data.name;
    }
    if (args.input.description !== undefined) {
      data.description = args.input.description.trim() || null;
      changes.description = data.description;
    }
    if (args.input.defaultPriceMonthly !== undefined) {
      data.defaultPriceMonthly = args.input.defaultPriceMonthly;
      changes.defaultPriceMonthly = args.input.defaultPriceMonthly;
    }
    if (args.input.defaultDepositAmount !== undefined) {
      data.defaultDepositAmount = args.input.defaultDepositAmount;
      changes.defaultDepositAmount = args.input.defaultDepositAmount;
    }
    if (args.input.color !== undefined) {
      data.color = args.input.color;
      changes.color = args.input.color;
    }
    if (args.input.features !== undefined) {
      data.features = args.input.features as Prisma.InputJsonValue;
      changes.features = args.input.features;
    }
    if (args.input.isActive !== undefined) {
      data.isActive = args.input.isActive;
      changes.isActive = args.input.isActive;
    }

    let updated: UnitType;
    try {
      updated = await this.prisma.withTenant(
        (tx) =>
          tx.unitType.update({
            where: { id: args.unitTypeId },
            data,
          }),
        args.tenantId,
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'unit_type_name_taken',
          message: 'Ya existe un tipo con ese nombre',
        });
      }
      throw err;
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit_type.updated',
      entityType: 'UnitType',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const withCount = await this.prisma.withTenant(
      (tx) =>
        tx.unitType.findUniqueOrThrow({
          where: { id: updated.id },
          include: { _count: { select: { units: true } } },
        }),
      args.tenantId,
    );
    return this.toDto(withCount);
  }

  async deleteOrDeactivate(args: DeleteArgs): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.unitType.findUnique({
          where: { id: args.unitTypeId },
          include: { _count: { select: { units: true } } },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'unit_type_not_found', message: 'Tipo no encontrado' });
    }
    // Si tiene units asociadas, no se borra: se desactiva. Las units
    // existentes mantienen la referencia historica.
    if ((existing._count?.units ?? 0) > 0) {
      await this.prisma.withTenant(
        (tx) =>
          tx.unitType.update({
            where: { id: existing.id },
            data: { isActive: false },
          }),
        args.tenantId,
      );
      await this.audit.write({
        tenantId: args.tenantId,
        userId: args.userId,
        action: 'unit_type.deactivated',
        entityType: 'UnitType',
        entityId: existing.id,
        changes: { reason: 'has_units', unitsCount: existing._count?.units ?? 0 },
        ipAddress: args.meta.ipAddress ?? null,
        userAgent: args.meta.userAgent ?? null,
      });
      return;
    }
    await this.prisma.withTenant(
      (tx) => tx.unitType.delete({ where: { id: existing.id } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit_type.deleted',
      entityType: 'UnitType',
      entityId: existing.id,
      changes: { name: existing.name },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  private toDto(row: UnitTypeWithCount): UnitTypeDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      defaultPriceMonthly: Number(row.defaultPriceMonthly),
      defaultDepositAmount: Number(row.defaultDepositAmount),
      color: row.color,
      features: (row.features as Record<string, unknown>) ?? {},
      isActive: row.isActive,
      unitsCount: row._count?.units ?? 0,
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
