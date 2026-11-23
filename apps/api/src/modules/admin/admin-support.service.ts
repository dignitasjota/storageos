import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  isValidSpanishTaxId,
  normalizeTaxId,
  type AdminUpdateTenantInput,
} from '@storageos/shared';

import { assertTaxIdFree } from '../../common/tax-id-unique';
import { AuditService } from '../auth/audit.service';
import { AuthService, type EmailDelivery, TENANT_OWNER_VERIFIED } from '../auth/auth.service';
import { SessionsService } from '../auth/sessions.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

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
    private readonly limits: PlanLimitsService,
    private readonly events: EventEmitter2,
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
    // En España el NIF tiene que ser válido (sale en sus facturas de suscripción).
    if (input.taxId) {
      const current = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { country: true },
      });
      const country = input.country ?? current?.country ?? 'ES';
      if (country === 'ES' && !isValidSpanishTaxId(input.taxId)) {
        throw new BadRequestException({
          code: 'invalid_tax_id',
          message: 'El NIF no es válido (revisa la letra o el dígito de control).',
        });
      }
    }
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.billingEmail !== undefined) data.billingEmail = input.billingEmail;
    if (input.country !== undefined) data.country = input.country;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.taxId !== undefined) {
      await assertTaxIdFree(this.admin, tenantId, input.taxId);
      data.taxId = input.taxId ? normalizeTaxId(input.taxId) : null;
    }
    if (input.billingLegalName !== undefined)
      data.billingLegalName = input.billingLegalName || null;
    if (input.billingAddress !== undefined) data.billingAddress = input.billingAddress || null;
    if (input.billingCity !== undefined) data.billingCity = input.billingCity || null;
    if (input.billingPostalCode !== undefined) {
      data.billingPostalCode = input.billingPostalCode || null;
    }

    await this.admin.tenant.update({ where: { id: tenantId }, data });
    await this.trace(tenantId, null, 'admin.tenant.updated', meta, { fields: Object.keys(data) });
  }

  // --------------------------------------------------------------- user actions

  /** Un usuario desactivado no puede entrar: no se le manda nada. */
  private assertActive(user: { isActive: boolean }): void {
    if (!user.isActive) {
      throw new BadRequestException({
        code: 'user_inactive',
        message: 'El usuario está desactivado: reactívalo antes de enviarle nada.',
      });
    }
  }

  /** El correo no ha salido (dirección bloqueada…): se dice y no se anota como enviado. */
  private assertDelivered(delivery: EmailDelivery): void {
    if (!delivery.sent) {
      throw new BadRequestException({
        code: 'email_not_sent',
        message: `El correo no ha salido${delivery.reason ? `: ${delivery.reason}` : ''}. Revisa la dirección en Correo saliente → Direcciones bloqueadas.`,
      });
    }
  }

  /** Reenvía el email de verificación al usuario (si no está ya verificado). */
  async resendVerification(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    await this.getTenant(tenantId);
    const user = await this.getUser(tenantId, userId);
    if (user.emailVerifiedAt) {
      throw new BadRequestException({
        code: 'already_verified',
        message: 'El email del usuario ya está verificado.',
      });
    }
    this.assertActive(user);
    this.assertDelivered(await this.auth.resendVerificationBySupport(tenantId, userId));
    await this.trace(tenantId, userId, 'admin.user.verification_resent', meta, {});
  }

  /**
   * Verifica manualmente el email del usuario (soporte): marca la cuenta como
   * activada sin que el usuario tenga que pulsar el enlace del email. Útil
   * cuando el operador no recibe/encuentra el correo de activación. Si es el
   * propietario, le llega la bienvenida como al activarla él.
   */
  async verifyEmailManually(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    await this.getTenant(tenantId);
    const user = await this.getUser(tenantId, userId);
    if (user.emailVerifiedAt) {
      throw new BadRequestException({
        code: 'already_verified',
        message: 'El email del usuario ya está verificado.',
      });
    }
    await this.admin.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    if (user.role === 'owner') this.events.emit(TENANT_OWNER_VERIFIED, { tenantId });
    await this.trace(tenantId, userId, 'admin.user.email_verified_manually', meta, {});
  }

  /** Envía el enlace para restablecer la contraseña (sin la IP del super admin). */
  async sendPasswordReset(tenantId: string, userId: string, meta: ActionMeta): Promise<void> {
    await this.getTenant(tenantId);
    const user = await this.getUser(tenantId, userId);
    this.assertActive(user);
    this.assertDelivered(await this.auth.sendPasswordResetBySupport(tenantId, userId));
    await this.trace(tenantId, userId, 'admin.user.password_reset_sent', meta, {});
  }

  /** Cierra todas las sesiones activas del usuario (también el acceso en curso). */
  async revokeSessions(tenantId: string, userId: string, meta: ActionMeta): Promise<number> {
    await this.getTenant(tenantId);
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
    await this.getTenant(tenantId);
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
    await this.getTenant(tenantId);
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

    // Reactivar un usuario cuenta contra `maxUsers` igual que invitar/crear uno:
    // si el tenant ya está en el tope (usuarios activos + invitaciones
    // pendientes), no se puede reactivar sin ampliar el plan → 403.
    if (active) {
      const [activeUsers, pendingInvites] = await Promise.all([
        this.admin.user.count({ where: { tenantId, isActive: true } }),
        this.admin.invitation.count({
          where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ]);
      try {
        await this.limits.assertCanCreate(tenantId, 'users', activeUsers + pendingInvites);
      } catch (err) {
        // El mensaje del límite está escrito para el tenant («amplía tu plan»).
        if (err instanceof ForbiddenException) {
          throw new ForbiddenException({
            code: 'users_limit_reached',
            message: `El tenant ya está en el tope de usuarios de su plan (${activeUsers} activos y ${pendingInvites} invitaciones pendientes). Desactiva otro usuario, revoca una invitación o súbele de plan antes de reactivarlo.`,
          });
        }
        throw err;
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
