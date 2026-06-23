import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { AuditService } from '../auth/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { User } from '@storageos/database';
import type {
  ChangePasswordInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserDetailDto,
  UserRole,
} from '@storageos/shared';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  // ============================= lectura ===================================

  async list(tenantId: string): Promise<UserDetailDto[]> {
    const users = await this.prisma.withTenant(
      (tx) =>
        tx.user.findMany({
          orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
          include: { facilities: { select: { facilityId: true } } },
        }),
      tenantId,
    );
    return users.map((u) => this.toDetail(u));
  }

  async detail(tenantId: string, userId: string): Promise<UserDetailDto> {
    const user = await this.prisma.withTenant(
      (tx) =>
        tx.user.findUnique({
          where: { id: userId },
          include: { facilities: { select: { facilityId: true } } },
        }),
      tenantId,
    );
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.toDetail(user);
  }

  // ============================= mutaciones ================================

  async update(args: {
    tenantId: string;
    actorUserId: string;
    actorRole: UserRole;
    targetUserId: string;
    input: UpdateUserInput;
    meta: RequestMeta;
  }): Promise<UserDetailDto> {
    const target = await this.admin.user.findFirst({
      where: { id: args.targetUserId, tenantId: args.tenantId },
    });
    if (!target) throw new NotFoundException('Usuario no encontrado');

    // Invariantes contra el ultimo owner.
    const wantsChangeRole = args.input.role !== undefined && args.input.role !== target.role;
    const wantsDeactivate = args.input.isActive === false && target.isActive;

    if (target.role === 'owner' && (wantsChangeRole || wantsDeactivate)) {
      throw new BadRequestException({
        message:
          'No se puede modificar el rol o desactivar al owner. Usa transfer-ownership primero.',
        code: 'owner_required',
      });
    }

    // Solo owner puede asignar role manager (manager puede asignar staff/readonly).
    if (args.input.role === 'manager' && args.actorRole !== 'owner') {
      throw new ForbiddenException({
        message: 'Solo el owner puede asignar el rol manager',
        code: 'insufficient_role',
      });
    }

    const updated = await this.admin.user.update({
      where: { id: target.id },
      data: {
        ...(args.input.fullName !== undefined ? { fullName: args.input.fullName.trim() } : {}),
        ...(args.input.phone !== undefined ? { phone: args.input.phone || null } : {}),
        ...(args.input.role !== undefined ? { role: args.input.role } : {}),
        ...(args.input.isActive !== undefined ? { isActive: args.input.isActive } : {}),
      },
    });

    // Si lo desactivamos, revocar sus sesiones.
    if (wantsDeactivate) {
      await this.sessions.revokeAllForUser({
        tenantId: args.tenantId,
        userId: target.id,
        reason: 'logout_all',
      });
    }

    const changes: Record<string, unknown> = {};
    if (wantsChangeRole) {
      changes.role = { from: target.role, to: updated.role };
    }
    if (args.input.isActive !== undefined && args.input.isActive !== target.isActive) {
      changes.isActive = { from: target.isActive, to: updated.isActive };
    }
    if (args.input.fullName !== undefined) changes.fullName = updated.fullName;
    if (args.input.phone !== undefined) changes.phone = updated.phone;

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: wantsChangeRole ? 'user.role_changed' : 'user.updated',
      entityType: 'User',
      entityId: updated.id,
      changes: changes as Record<string, unknown> &
        Parameters<typeof this.audit.write>[0]['changes'],
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.toDetail(updated);
  }

  /**
   * Desactiva el usuario (soft). Bloquea si es el unico owner.
   */
  async deactivate(args: {
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    meta: RequestMeta;
  }): Promise<void> {
    if (args.targetUserId === args.actorUserId) {
      throw new BadRequestException({
        message: 'No puedes desactivarte a ti mismo',
        code: 'cannot_target_self',
      });
    }
    const target = await this.admin.user.findFirst({
      where: { id: args.targetUserId, tenantId: args.tenantId },
    });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (target.role === 'owner') {
      throw new BadRequestException({
        message: 'No se puede desactivar al owner. Transfiere la propiedad primero.',
        code: 'owner_required',
      });
    }
    if (!target.isActive) return;

    await this.admin.user.update({
      where: { id: target.id },
      data: { isActive: false },
    });
    await this.sessions.revokeAllForUser({
      tenantId: args.tenantId,
      userId: target.id,
      reason: 'logout_all',
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'user.deactivated',
      entityType: 'User',
      entityId: target.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Transfiere el rol owner del actor a otro user del tenant.
   * El actor pasa a `manager`. Atomico.
   */
  async transferOwnership(args: {
    tenantId: string;
    fromUserId: string;
    toUserId: string;
    meta: RequestMeta;
  }): Promise<void> {
    if (args.fromUserId === args.toUserId) {
      throw new BadRequestException({
        message: 'Origen y destino deben ser usuarios distintos',
        code: 'invalid_target',
      });
    }
    const target = await this.admin.user.findFirst({
      where: { id: args.toUserId, tenantId: args.tenantId },
    });
    if (!target) throw new NotFoundException('Usuario destino no encontrado');
    if (!target.isActive) {
      throw new BadRequestException({
        message: 'El destinatario esta desactivado',
        code: 'target_inactive',
      });
    }

    await this.admin.$transaction([
      this.admin.user.update({
        where: { id: args.fromUserId },
        data: { role: 'manager' },
      }),
      this.admin.user.update({
        where: { id: target.id },
        data: { role: 'owner' },
      }),
    ]);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.fromUserId,
      action: 'user.ownership_transferred',
      entityType: 'User',
      entityId: target.id,
      changes: { fromUserId: args.fromUserId, toUserId: target.id },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  // ============================== /me ======================================

  async updateProfile(args: {
    tenantId: string;
    userId: string;
    input: UpdateProfileInput;
    meta: RequestMeta;
  }): Promise<UserDetailDto> {
    const updated = await this.admin.user.update({
      where: { id: args.userId },
      data: {
        ...(args.input.fullName !== undefined ? { fullName: args.input.fullName.trim() } : {}),
        ...(args.input.phone !== undefined ? { phone: args.input.phone || null } : {}),
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'me.profile_updated',
      entityType: 'User',
      entityId: args.userId,
      changes: {
        ...(args.input.fullName !== undefined ? { fullName: updated.fullName } : {}),
        ...(args.input.phone !== undefined ? { phone: updated.phone } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDetail(updated);
  }

  async changePassword(args: {
    tenantId: string;
    userId: string;
    currentSessionId: string | null;
    input: ChangePasswordInput;
    meta: RequestMeta;
  }): Promise<void> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: args.userId } });
    const matches = await argonVerify(user.passwordHash, args.input.currentPassword);
    if (!matches) {
      throw new ForbiddenException({
        message: 'La contrasena actual no es correcta',
        code: 'wrong_current_password',
      });
    }
    if (args.input.currentPassword === args.input.newPassword) {
      throw new BadRequestException({
        message: 'La nueva contrasena debe ser distinta de la actual',
        code: 'same_password',
      });
    }
    const newHash = await argonHash(args.input.newPassword);
    await this.admin.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

    // Revoca todas las sesiones del user EXCEPTO la actual (que sigue
    // valida tras el cambio).
    await this.admin.session.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(args.currentSessionId ? { id: { not: args.currentSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: 'logout_all' },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: user.id,
      action: 'me.password_changed',
      entityType: 'User',
      entityId: user.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  // ============================= helpers ===================================

  private toDetail(user: User & { facilities?: { facilityId: string }[] }): UserDetailDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role as UserRole,
      tenantRoleId: user.tenantRoleId,
      facilityIds: user.facilities?.map((f) => f.facilityId) ?? [],
      isActive: user.isActive,
      emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
      twoFactorEnabled: user.twoFactorEnabled,
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
