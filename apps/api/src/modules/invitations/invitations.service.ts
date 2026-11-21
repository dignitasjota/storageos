import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash } from '@node-rs/argon2';
import { permissionsForRole } from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { type AuthFlowResult, type RequestMeta } from '../auth/auth.service';
import { SessionsService } from '../auth/sessions.service';
import { TokensService } from '../auth/tokens.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { InvitationEmail } from '../email/templates/invitation-email';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
import { SecurityEventsService } from '../security-events/security-events.service';

import { InvitationTokensService } from './invitation-tokens.service';

import type { Env } from '../../config/env.schema';
import type { Invitation } from '@storageos/database';
import type {
  AcceptInvitationInput,
  AuthSuccessResponse,
  InvitationDto,
  InvitationStatus,
  InviteUserInput,
  Permission,
  PublicInvitationDto,
  SubscriptionDto,
  TenantDto,
  UserDto,
  UserRole,
} from '@storageos/shared';

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly invitationTokens: InvitationTokensService,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly securityEvents: SecurityEventsService,
    private readonly limits: PlanLimitsService,
  ) {}

  // ============================ list/create ================================

  async list(tenantId: string): Promise<InvitationDto[]> {
    const rows = await this.admin.invitation.findMany({
      where: { tenantId },
      include: { invitedBy: true, tenantRole: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Solo el propietario puede dar el rol de gestor (como al editar un usuario). */
  private assertCanInviteRole(inviterRole: UserRole, role: string): void {
    if (role === 'owner') {
      throw new BadRequestException({
        message: 'No se puede invitar como propietario: usa la transferencia de la propiedad',
        code: 'invalid_role',
      });
    }
    if (role === 'manager' && inviterRole !== 'owner') {
      throw new ForbiddenException({
        message: 'Solo el propietario puede invitar a un gestor',
        code: 'insufficient_role',
      });
    }
  }

  /**
   * Rol a medida y locales que tendrá al aceptar. Solo los elige el
   * propietario (como al editar a un usuario); ambos del mismo negocio y los
   * locales sin borrar.
   */
  private async resolveAccess(
    tenantId: string,
    inviterRole: UserRole,
    input: Pick<InviteUserInput, 'tenantRoleId' | 'facilityIds'>,
  ): Promise<{ tenantRoleId: string | null; facilityIds: string[] }> {
    const tenantRoleId = input.tenantRoleId ?? null;
    const facilityIds = [...new Set(input.facilityIds ?? [])];
    if ((tenantRoleId || facilityIds.length > 0) && inviterRole !== 'owner') {
      throw new ForbiddenException({
        message: 'Solo el propietario puede elegir el rol a medida o los locales al invitar.',
        code: 'insufficient_role',
      });
    }
    if (tenantRoleId) {
      const role = await this.admin.tenantRole.findFirst({
        where: { id: tenantRoleId, tenantId },
        select: { id: true },
      });
      if (!role) {
        throw new BadRequestException({
          message: 'Ese rol a medida no existe.',
          code: 'role_not_found',
        });
      }
    }
    if (facilityIds.length > 0) {
      const valid = await this.admin.facility.count({
        where: { id: { in: facilityIds }, tenantId, deletedAt: null },
      });
      if (valid !== facilityIds.length) {
        throw new BadRequestException({
          message: 'Algún local no existe o se ha borrado.',
          code: 'facility_not_found',
        });
      }
    }
    return { tenantRoleId, facilityIds };
  }

  async create(args: {
    tenantId: string;
    inviterUserId: string;
    inviterRole: UserRole;
    inviterName: string;
    input: InviteUserInput;
    meta: RequestMeta;
  }): Promise<InvitationDto> {
    const email = args.input.email;
    this.assertCanInviteRole(args.inviterRole, args.input.role);
    const access = await this.resolveAccess(args.tenantId, args.inviterRole, args.input);

    // Si el email ya es user del tenant: 409.
    const existingUser = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: args.tenantId, email } },
    });
    if (existingUser) {
      throw new ConflictException({
        message: 'Ese email ya pertenece a un usuario del tenant',
        code: 'email_already_user',
      });
    }

    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: args.tenantId } });
    const { secret, tokenHash } = await this.invitationTokens.hashSecret();
    const expiresAt = this.invitationTokens.buildExpiry();

    // Límite de usuarios + creación en una sola transacción con un lock por
    // tenant, para que dos invitaciones concurrentes no superen el tope del
    // plan (TOCTOU entre contar y crear). Cuenta usuarios activos +
    // invitaciones pendientes.
    const record = await this.admin.$transaction(async (tx) => {
      await this.limits.lockForCreate(tx, args.tenantId, 'users');
      const [activeUsers, pendingInvites] = await Promise.all([
        tx.user.count({ where: { tenantId: args.tenantId, isActive: true } }),
        tx.invitation.count({
          where: {
            tenantId: args.tenantId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      await this.limits.assertCanCreate(args.tenantId, 'users', activeUsers + pendingInvites);

      // Si ya hay una invitacion pendiente para ese email: 409.
      const pending = await tx.invitation.findFirst({
        where: {
          tenantId: args.tenantId,
          email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (pending) {
        throw new ConflictException({
          message: 'Ya hay una invitacion pendiente para ese email',
          code: 'invitation_pending',
        });
      }
      // Una caducada sin revocar sigue ocupando el índice único de pendientes
      // (tenant, email): se cierra para poder crear la nueva.
      await tx.invitation.updateMany({
        where: { tenantId: args.tenantId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });

      return tx.invitation.create({
        data: {
          tenantId: args.tenantId,
          email,
          role: args.input.role,
          invitedByUserId: args.inviterUserId,
          tokenHash,
          expiresAt,
          tenantRoleId: access.tenantRoleId,
          facilityIds: access.facilityIds,
        },
        include: { invitedBy: true, tenantRole: { select: { name: true } } },
      });
    });

    await this.sendInvitationEmail(
      record,
      args.inviterName,
      tenant.name,
      secret,
      args.input.fullName,
    );

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.inviterUserId,
      action: 'invitation.sent',
      entityType: 'Invitation',
      entityId: record.id,
      changes: {
        email,
        role: args.input.role,
        ...(access.tenantRoleId ? { tenantRoleId: access.tenantRoleId } : {}),
        ...(access.facilityIds.length > 0 ? { facilityIds: access.facilityIds } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.toDto(record);
  }

  // ============================ revoke/resend ==============================

  async revoke(args: { tenantId: string; userId: string; invitationId: string }): Promise<void> {
    const result = await this.admin.invitation.updateMany({
      where: {
        id: args.invitationId,
        tenantId: args.tenantId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedReason: 'manual' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Invitacion no encontrada o ya consumida');
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invitation.revoked',
      entityType: 'Invitation',
      entityId: args.invitationId,
      changes: { reason: 'manual' },
    });
  }

  async resend(args: {
    tenantId: string;
    userId: string;
    inviterRole: UserRole;
    inviterName: string;
    invitationId: string;
    meta: RequestMeta;
  }): Promise<InvitationDto> {
    const original = await this.admin.invitation.findFirst({
      where: { id: args.invitationId, tenantId: args.tenantId },
      include: { invitedBy: true },
    });
    if (!original) {
      throw new NotFoundException('Invitacion no encontrada');
    }
    if (original.acceptedAt !== null) {
      throw new BadRequestException({
        message: 'La invitacion ya se acepto',
        code: 'invitation_already_accepted',
      });
    }

    this.assertCanInviteRole(args.inviterRole, original.role);
    // El rol a medida y los locales solo los gestiona el propietario.
    if (
      (original.tenantRoleId || original.facilityIds.length > 0) &&
      args.inviterRole !== 'owner'
    ) {
      throw new ForbiddenException({
        message: 'Esta invitación lleva un rol a medida o locales: solo la reenvía el propietario.',
        code: 'insufficient_role',
      });
    }
    const liveFacilities =
      original.facilityIds.length > 0
        ? (
            await this.admin.facility.findMany({
              where: { id: { in: original.facilityIds }, tenantId: args.tenantId, deletedAt: null },
              select: { id: true },
            })
          ).map((f) => f.id)
        : [];
    // Sin locales vivos vería todos: mejor invitar de nuevo eligiendo otros.
    if (original.facilityIds.length > 0 && liveFacilities.length === 0) {
      throw new BadRequestException({
        message:
          'Los locales de esta invitación se han borrado. Invítale de nuevo eligiendo otros.',
        code: 'invitation_facilities_gone',
      });
    }

    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: args.tenantId } });
    const { secret, tokenHash } = await this.invitationTokens.hashSecret();
    const expiresAt = this.invitationTokens.buildExpiry();
    // Invalidar la actual (si estaba pendiente) y crear una nueva con el mismo
    // email y rol. Una caducada o revocada vuelve a ocupar plaza: se comprueba
    // el límite de usuarios del plan, con el mismo bloqueo que al invitar.
    const fresh = await this.admin.$transaction(async (tx) => {
      await this.limits.lockForCreate(tx, args.tenantId, 'users');
      const now = new Date();
      await tx.invitation.updateMany({
        where: { id: original.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'replaced_by_resend' },
      });
      const [activeUsers, pendingInvites, alreadyUser] = await Promise.all([
        tx.user.count({ where: { tenantId: args.tenantId, isActive: true } }),
        tx.invitation.count({
          where: {
            tenantId: args.tenantId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        }),
        tx.user.findUnique({
          where: { tenantId_email: { tenantId: args.tenantId, email: original.email } },
          select: { id: true },
        }),
      ]);
      if (alreadyUser) {
        throw new ConflictException({
          message: 'Ese email ya pertenece a un usuario del tenant',
          code: 'email_already_user',
        });
      }
      await this.limits.assertCanCreate(args.tenantId, 'users', activeUsers + pendingInvites);
      // Otra invitación pendiente al mismo email (p. ej. creada después).
      await tx.invitation.updateMany({
        where: {
          tenantId: args.tenantId,
          email: original.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now, revokedReason: 'replaced_by_resend' },
      });
      return tx.invitation.create({
        data: {
          tenantId: args.tenantId,
          email: original.email,
          role: original.role,
          invitedByUserId: args.userId,
          tokenHash,
          expiresAt,
          // Conserva lo elegido al invitar (sin los locales ya borrados).
          tenantRoleId: original.tenantRoleId,
          facilityIds: liveFacilities,
        },
        include: { invitedBy: true, tenantRole: { select: { name: true } } },
      });
    });

    await this.sendInvitationEmail(fresh, args.inviterName, tenant.name, secret);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invitation.resent',
      entityType: 'Invitation',
      entityId: fresh.id,
      changes: { previousId: original.id, email: original.email, role: original.role },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.toDto(fresh);
  }

  // ============================== public ===================================

  async findByToken(token: string, meta: RequestMeta = {}): Promise<PublicInvitationDto> {
    const record = await this.invitationTokens.lookup(token);
    if (!record) {
      // Era la ultima traza de seguridad sin registrar: los bots que
      // prueban tokens de invitacion quedan ahora en security_events.
      await this.securityEvents.record({
        eventType: 'invitation_token_invalid',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        reason: 'lookup_failed',
      });
      throw new NotFoundException('Token invalido o caducado');
    }
    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: record.tenantId } });
    const inviter = record.invitedByUserId
      ? await this.admin.user.findUnique({ where: { id: record.invitedByUserId } })
      : null;
    return {
      email: record.email,
      role: record.role,
      tenant: { name: tenant.name, slug: tenant.slug },
      inviterName: inviter?.fullName ?? null,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  async accept(
    token: string,
    input: AcceptInvitationInput,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const record = await this.invitationTokens.lookup(token);
    if (!record) {
      await this.securityEvents.record({
        eventType: 'invitation_token_invalid',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        reason: 'accept_failed',
      });
      throw new NotFoundException('Token invalido o caducado');
    }

    // Rol a medida (si sigue existiendo) y locales (los que sigan sin borrar).
    const customRole = record.tenantRoleId
      ? await this.admin.tenantRole.findFirst({
          where: { id: record.tenantRoleId, tenantId: record.tenantId },
          select: { id: true, permissions: true },
        })
      : null;
    const facilityIds =
      record.facilityIds.length > 0
        ? (
            await this.admin.facility.findMany({
              where: { id: { in: record.facilityIds }, tenantId: record.tenantId, deletedAt: null },
              select: { id: true },
            })
          ).map((f) => f.id)
        : [];
    // Si todos sus locales se han borrado vería todos: que le inviten de nuevo.
    if (record.facilityIds.length > 0 && facilityIds.length === 0) {
      throw new ConflictException({
        message: 'Los locales de esta invitación ya no existen. Pide que te inviten de nuevo.',
        code: 'invitation_facilities_gone',
      });
    }

    // Marca aceptada atomicamente. Si dos requests llegan a la vez, solo
    // uno gana.
    const accepted = await this.invitationTokens.markAccepted(record.id);
    if (!accepted) {
      throw new ConflictException('La invitacion ya se ha consumido');
    }

    // Doble-check: no debe haber un user con ese email en el tenant
    // (puede haberse creado tras enviar la invitacion).
    const existing = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: record.tenantId, email: record.email } },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Ya existe un usuario con ese email en el tenant',
        code: 'email_already_user',
      });
    }

    const passwordHash = await argonHash(input.password);
    const user = await this.admin.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId: record.tenantId,
          email: record.email,
          passwordHash,
          fullName: input.fullName.trim(),
          role: record.role,
          emailVerifiedAt: new Date(),
          tenantRoleId: customRole?.id ?? null,
        },
      });
      if (facilityIds.length > 0) {
        await tx.userFacility.createMany({
          data: facilityIds.map((facilityId) => ({
            tenantId: record.tenantId,
            userId: created.id,
            facilityId,
          })),
        });
      }
      return created;
    });

    await this.audit.write({
      tenantId: record.tenantId,
      userId: user.id,
      action: 'invitation.accepted',
      entityType: 'Invitation',
      entityId: record.id,
      changes: { role: record.role },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.audit.write({
      tenantId: record.tenantId,
      userId: user.id,
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      changes: {
        role: record.role,
        viaInvitationId: record.id,
        ...(customRole ? { tenantRoleId: customRole.id } : {}),
        ...(facilityIds.length > 0 ? { facilityIds } : {}),
      },
    });

    // Emitir sesion (auto-login).
    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: record.tenantId } });
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId: record.tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new Error('Tenant sin suscripcion');
    }

    const { refreshToken } = await this.sessions.createForLogin({
      tenantId: record.tenantId,
      userId: user.id,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      installedApp: meta.installedApp,
    });
    const { token: accessToken, expiresIn } = await this.tokens.signAccess({
      sub: user.id,
      tenantId: record.tenantId,
      // El rol a medida y los locales elegidos al invitar ya rigen desde el primer acceso.
      role: user.role,
      permissions: customRole
        ? (customRole.permissions as Permission[])
        : permissionsForRole(user.role),
      facilityScope: facilityIds.length > 0 ? facilityIds : null,
      tenantRoleId: customRole?.id ?? null,
    });

    const userDto: UserDto = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone ?? null,
      role: user.role as UserRole,
      twoFactorEnabled: user.twoFactorEnabled,
    };
    const tenantDto: TenantDto = {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
      locale: tenant.locale,
      currency: tenant.currency,
      timezone: tenant.timezone,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      logoUploaded: tenant.portalLogoKey !== null,
    };
    const subscriptionDto: SubscriptionDto = {
      status: subscription.status,
      planSlug: subscription.plan.slug,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    };

    return {
      body: {
        user: userDto,
        tenant: tenantDto,
        subscription: subscriptionDto,
        accessToken,
        expiresIn,
      },
      refreshToken,
    };
  }

  // ============================= helpers ===================================

  private async sendInvitationEmail(
    record: Invitation,
    inviterName: string,
    tenantName: string,
    secret: string,
    recipientName?: string,
  ): Promise<void> {
    const baseUrl = this.config.get('WEB_BASE_URL', { infer: true });
    const acceptUrl = `${baseUrl}/invite/${this.invitationTokens.formatPlaintext(record.id, secret)}`;
    try {
      await this.email.send({
        to: record.email,
        kind: 'invitation',
        subject: `${inviterName} te ha invitado a ${tenantName} en TrasterOS`,
        template: InvitationEmail({
          recipientName: recipientName ?? record.email,
          inviterName,
          tenantName,
          role: record.role,
          acceptUrl,
        }),
      });
    } catch (err) {
      this.logger.error(
        `Fallo al enviar email de invitacion ${record.id}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  private toDto(
    record: Invitation & {
      invitedBy?: { fullName: string } | null;
      tenantRole?: { name: string } | null;
    },
  ): InvitationDto {
    const status: InvitationStatus = record.acceptedAt
      ? 'accepted'
      : record.revokedAt
        ? 'revoked'
        : record.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'pending';
    return {
      id: record.id,
      email: record.email,
      role: record.role,
      invitedByName: record.invitedBy?.fullName ?? null,
      status,
      expiresAt: record.expiresAt.toISOString(),
      acceptedAt: record.acceptedAt ? record.acceptedAt.toISOString() : null,
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
      revokedReason: record.revokedReason ?? null,
      tenantRoleId: record.tenantRoleId,
      tenantRoleName: record.tenantRole?.name ?? null,
      facilityIds: record.facilityIds,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
