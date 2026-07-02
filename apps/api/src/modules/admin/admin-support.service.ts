import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { AuthService } from '../auth/auth.service';
import { SessionsService } from '../auth/sessions.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { AdminUpdateTenantInput } from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  reason?: string | null | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

/**
 * Acciones de soporte del super admin sobre un tenant y sus usuarios
 * (cross-tenant, vía `PrismaAdminService`). Reutiliza los servicios de auth
 * (verificación, reset de contraseña, sesiones) donde es posible y hace Prisma
 * directo para lo que no tiene una vía de soporte (quitar 2FA, activar/desactivar).
 * Toda acción deja rastro en `audit_logs` del tenant + `super_admin_audit_logs`.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  // ----------------------------------------------------------------- helpers

  private async getTenant(tenantId: string): Promise<{ slug: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    return { slug: tenant.slug };
  }

  private async getUser(tenantId: string, userId: string) {
    const user = await this.admin.user.findFirst({
      where: { id: userId, tenantId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        emailVerifiedAt: true,
        twoFactorEnabled: true,
      },
    });
    if (!user) {
      throw new NotFoundException({ code: 'user_not_found', message: 'Usuario no encontrado' });
    }
    return user;
  }

  private async trace(
    tenantId: string,
    userId: string | null,
    action: string,
    meta: ActionMeta,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId: null,
      action,
      entityType: userId ? 'User' : 'Tenant',
      entityId: userId ?? tenantId,
      changes: { superAdminId: meta.superAdminId, ...changes },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action,
      targetType: userId ? 'user' : 'tenant',
      targetId: userId ?? tenantId,
      targetTenantId: tenantId,
      changes,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // --------------------------------------------------------------- tenant edit

  async updateTenant(
    tenantId: string,
    input: AdminUpdateTenantInput,
    meta: ActionMeta,
  ): Promise<void> {
    await this.getTenant(tenantId);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.billingEmail !== undefined) data.billingEmail = input.billingEmail;
    if (input.country !== undefined) data.country = input.country;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.taxId !== undefined) data.taxId = input.taxId;

    await this.admin.tenant.update({ where: { id: tenantId }, data });
    await this.trace(tenantId, null, 'admin.tenant.updated', meta, { fields: Object.keys(data) });
  }

  // --------------------------------------------------------------- user actions

  /** Reenvía el email de verificación al usuario (si no está ya verificado). */
  async resendVerification(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    const { slug } = await this.getTenant(tenantId);
    const user = await this.getUser(tenantId, userId);
    if (user.emailVerifiedAt) {
      throw new BadRequestException({
        code: 'already_verified',
        message: 'El email del usuario ya está verificado.',
      });
    }
    await this.auth.resendVerification({ tenantSlug: slug, email: user.email });
    await this.trace(tenantId, userId, 'admin.user.verification_resent', meta, {});
  }

  /** Dispara el flujo de restablecimiento de contraseña (email con enlace). */
  async sendPasswordReset(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    const { slug } = await this.getTenant(tenantId);
    const user = await this.getUser(tenantId, userId);
    await this.auth.forgotPassword(
      { tenantSlug: slug, email: user.email },
      { ipAddress: meta.ipAddress ?? undefined, userAgent: meta.userAgent ?? undefined },
    );
    await this.trace(tenantId, userId, 'admin.user.password_reset_sent', meta, {});
  }

  /** Cierra todas las sesiones activas del usuario. */
  async revokeSessions(tenantId: string, userId: string, meta: ActionMeta): Promise<number> {
    await this.getUser(tenantId, userId);
    const revoked = await this.sessions.revokeAllForUser({
      tenantId,
      userId,
      reason: 'logout_all',
    });
    await this.trace(tenantId, userId, 'admin.user.sessions_revoked', meta, { revoked });
    return revoked;
  }

  /** Desactiva el 2FA del usuario (recuperación de cuenta por soporte). */
  async disableTwoFactor(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    const user = await this.getUser(tenantId, userId);
    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'twofactor_not_enabled',
        message: 'El usuario no tiene el 2FA activado.',
      });
    }
    await this.admin.user.update({
      where: { id: userId },
      data: {
        twoFactorSecretEncrypted: null,
        twoFactorPendingSecretEncrypted: null,
        twoFactorEnabled: false,
        twoFactorEnrolledAt: null,
      },
    });
    await this.admin.recoveryCode.deleteMany({ where: { userId } });
    await this.trace(tenantId, userId, 'admin.user.2fa_disabled', meta, {});
  }

  /** Activa o desactiva un usuario; al desactivar cierra sus sesiones. */
  async setUserActive(
    tenantId: string,
    userId: string,
    active: boolean,
    meta: ActionMeta,
  ): Promise<void> {
    const user = await this.getUser(tenantId, userId);
    if (user.isActive === active) return; // idempotente

    if (!active && user.role === 'owner') {
      const otherOwners = await this.admin.user.count({
        where: { tenantId, role: 'owner', isActive: true, id: { not: userId } },
      });
      if (otherOwners === 0) {
        throw new BadRequestException({
          code: 'last_owner',
          message: 'No puedes desactivar al único propietario activo del tenant.',
        });
      }
    }

    await this.admin.user.update({ where: { id: userId }, data: { isActive: active } });
    if (!active) {
      await this.sessions.revokeAllForUser({ tenantId, userId, reason: 'logout_all' });
    }
    await this.trace(
      tenantId,
      userId,
      active ? 'admin.user.reactivated' : 'admin.user.deactivated',
      meta,
      {},
    );
  }
}
