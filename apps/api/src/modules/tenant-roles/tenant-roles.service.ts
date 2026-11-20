import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateTenantRoleInput,
  Permission,
  TenantRoleDto,
  UpdateTenantRoleInput,
} from '@storageos/shared';

type TenantRoleRow = Prisma.TenantRoleGetPayload<{
  include: { _count: { select: { users: true } } };
}>;

function toDto(row: TenantRoleRow): TenantRoleDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions as Permission[],
    baseRole: row.baseRole,
    userCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Quién hace el cambio (para comprobar que es el propietario y auditar). */
export interface RoleActor {
  userId: string;
  role: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class TenantRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Los roles a medida y los locales de cada persona solo los gestiona el
   * propietario: con `settings:manage` o `users:manage` en un rol a medida
   * se podía crear un rol con todos los permisos y asignárselo.
   */
  private assertOwner(actor: RoleActor): void {
    if (actor.role !== 'owner') {
      throw new ForbiddenException({
        message: 'Solo el propietario puede gestionar los roles y los locales de cada persona',
        code: 'owner_only',
      });
    }
  }

  private assertNotSelf(actor: RoleActor, userId: string): void {
    if (actor.userId === userId) {
      throw new BadRequestException({
        message: 'No puedes cambiar tus propios permisos',
        code: 'cannot_target_self',
      });
    }
  }

  private async trace(
    tenantId: string,
    actor: RoleActor,
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
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  async list(tenantId: string): Promise<TenantRoleDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.tenantRole.findMany({
          include: { _count: { select: { users: true } } },
          orderBy: { name: 'asc' },
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async create(
    tenantId: string,
    input: CreateTenantRoleInput,
    actor: RoleActor,
  ): Promise<TenantRoleDto> {
    this.assertOwner(actor);
    const dto = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.tenantRole.findFirst({ where: { name: input.name } });
      if (existing) {
        throw new ConflictException({
          message: 'Ya existe un rol con ese nombre',
          code: 'role_name_taken',
        });
      }
      const row = await tx.tenantRole.create({
        data: {
          tenantId,
          name: input.name,
          description: input.description || null,
          permissions: input.permissions,
          baseRole: input.baseRole,
        },
        include: { _count: { select: { users: true } } },
      });
      return toDto(row);
    }, tenantId);
    await this.trace(tenantId, actor, 'tenant_role.created', 'TenantRole', dto.id, {
      name: dto.name,
      permissions: dto.permissions,
    });
    return dto;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateTenantRoleInput,
    actor: RoleActor,
  ): Promise<TenantRoleDto> {
    this.assertOwner(actor);
    let before: { name: string; permissions: string[] } | null = null;
    const dto = await this.prisma.withTenant(async (tx) => {
      const role = await tx.tenantRole.findUnique({ where: { id } });
      if (!role)
        throw new NotFoundException({ message: 'Rol no encontrado', code: 'role_not_found' });

      if (input.name && input.name !== role.name) {
        const dup = await tx.tenantRole.findFirst({ where: { name: input.name } });
        if (dup) {
          throw new ConflictException({
            message: 'Ya existe un rol con ese nombre',
            code: 'role_name_taken',
          });
        }
      }

      before = { name: role.name, permissions: role.permissions };
      const row = await tx.tenantRole.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          // Vacía = sin descripción.
          ...(input.description !== undefined ? { description: input.description || null } : {}),
          ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
          ...(input.baseRole !== undefined ? { baseRole: input.baseRole } : {}),
        },
        include: { _count: { select: { users: true } } },
      });
      return toDto(row);
    }, tenantId);
    const prev = before as { name: string; permissions: string[] } | null;
    const added = dto.permissions.filter((p) => !prev?.permissions.includes(p));
    const removed = (prev?.permissions ?? []).filter(
      (p) => !dto.permissions.includes(p as Permission),
    );
    await this.trace(tenantId, actor, 'tenant_role.updated', 'TenantRole', dto.id, {
      ...(prev && prev.name !== dto.name ? { name: { from: prev.name, to: dto.name } } : {}),
      ...(added.length > 0 ? { permissionsAdded: added } : {}),
      ...(removed.length > 0 ? { permissionsRemoved: removed } : {}),
    });
    return dto;
  }

  async remove(tenantId: string, id: string, actor: RoleActor): Promise<void> {
    this.assertOwner(actor);
    const removed = await this.prisma.withTenant(async (tx) => {
      const role = await tx.tenantRole.findUnique({
        where: { id },
        include: { _count: { select: { users: true } } },
      });
      if (!role)
        throw new NotFoundException({ message: 'Rol no encontrado', code: 'role_not_found' });
      // La FK users.tenant_role_id es ON DELETE SET NULL: los usuarios vuelven
      // a su rol enum automáticamente.
      await tx.tenantRole.delete({ where: { id } });
      return role;
    }, tenantId);
    await this.trace(tenantId, actor, 'tenant_role.deleted', 'TenantRole', id, {
      name: removed.name,
      users: removed._count.users,
    });
  }

  /** Asigna (o quita, con `null`) un rol custom a un usuario del tenant. */
  async assignToUser(
    tenantId: string,
    userId: string,
    tenantRoleId: string | null,
    actor: RoleActor,
  ): Promise<void> {
    this.assertOwner(actor);
    const change = await this.prisma.withTenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user)
        throw new NotFoundException({ message: 'Usuario no encontrado', code: 'user_not_found' });
      if (tenantRoleId && user.role === 'owner') {
        throw new BadRequestException({
          message: 'El propietario tiene siempre todos los permisos',
          code: 'owner_full_access',
        });
      }
      this.assertNotSelf(actor, userId);

      let roleName: string | null = null;
      if (tenantRoleId) {
        const role = await tx.tenantRole.findUnique({ where: { id: tenantRoleId } });
        if (!role) {
          throw new BadRequestException({ message: 'Rol no encontrado', code: 'role_not_found' });
        }
        roleName = role.name;
      }
      await tx.user.update({ where: { id: userId }, data: { tenantRoleId } });
      return { from: user.tenantRoleId, to: tenantRoleId, roleName };
    }, tenantId);
    if (change.from !== change.to) {
      await this.trace(tenantId, actor, 'user.tenant_role_changed', 'User', userId, {
        tenantRoleId: { from: change.from, to: change.to },
        ...(change.roleName ? { roleName: change.roleName } : {}),
      });
    }
  }

  /**
   * Permisos por local: fija a qué locales está restringido un usuario.
   * `[]` = sin restricción (ve todos). Reescribe la lista completa.
   */
  async setUserFacilities(
    tenantId: string,
    userId: string,
    facilityIds: string[],
    actor: RoleActor,
  ): Promise<void> {
    this.assertOwner(actor);
    const before = await this.prisma.withTenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({ message: 'Usuario no encontrado', code: 'user_not_found' });
      }
      const unique = [...new Set(facilityIds)];
      if (unique.length > 0 && user.role === 'owner') {
        throw new BadRequestException({
          message: 'El propietario ve siempre todos los locales',
          code: 'owner_full_access',
        });
      }
      this.assertNotSelf(actor, userId);
      if (unique.length > 0) {
        const valid = await tx.facility.count({
          where: { id: { in: unique }, deletedAt: null },
        });
        if (valid !== unique.length) {
          throw new BadRequestException({
            message: 'Algún local no existe',
            code: 'facility_not_found',
          });
        }
      }
      const previous = await tx.userFacility.findMany({
        where: { userId },
        select: { facilityId: true },
      });
      await tx.userFacility.deleteMany({ where: { userId } });
      if (unique.length > 0) {
        await tx.userFacility.createMany({
          data: unique.map((facilityId) => ({ tenantId, userId, facilityId })),
        });
      }
      return previous.map((r) => r.facilityId);
    }, tenantId);
    const after = [...new Set(facilityIds)];
    const same = before.length === after.length && before.every((id) => after.includes(id));
    if (!same) {
      await this.trace(tenantId, actor, 'user.facilities_changed', 'User', userId, {
        facilityIds: { from: before, to: after },
      });
    }
  }
}
