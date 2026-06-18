import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

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

@Injectable()
export class TenantRolesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(tenantId: string, input: CreateTenantRoleInput): Promise<TenantRoleDto> {
    return this.prisma.withTenant(async (tx) => {
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
          description: input.description ?? null,
          permissions: input.permissions,
          baseRole: input.baseRole,
        },
        include: { _count: { select: { users: true } } },
      });
      return toDto(row);
    }, tenantId);
  }

  async update(tenantId: string, id: string, input: UpdateTenantRoleInput): Promise<TenantRoleDto> {
    return this.prisma.withTenant(async (tx) => {
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

      const row = await tx.tenantRole.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
          ...(input.baseRole !== undefined ? { baseRole: input.baseRole } : {}),
        },
        include: { _count: { select: { users: true } } },
      });
      return toDto(row);
    }, tenantId);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const role = await tx.tenantRole.findUnique({ where: { id } });
      if (!role)
        throw new NotFoundException({ message: 'Rol no encontrado', code: 'role_not_found' });
      // La FK users.tenant_role_id es ON DELETE SET NULL: los usuarios vuelven
      // a su rol enum automáticamente.
      await tx.tenantRole.delete({ where: { id } });
    }, tenantId);
  }

  /** Asigna (o quita, con `null`) un rol custom a un usuario del tenant. */
  async assignToUser(tenantId: string, userId: string, tenantRoleId: string | null): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user)
        throw new NotFoundException({ message: 'Usuario no encontrado', code: 'user_not_found' });

      if (tenantRoleId) {
        const role = await tx.tenantRole.findUnique({ where: { id: tenantRoleId } });
        if (!role) {
          throw new BadRequestException({ message: 'Rol no encontrado', code: 'role_not_found' });
        }
      }
      await tx.user.update({ where: { id: userId }, data: { tenantRoleId } });
    }, tenantId);
  }
}
