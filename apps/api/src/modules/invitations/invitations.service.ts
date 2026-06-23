import {
  BadRequestException,
  ConflictException,
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
  ) {}

  // ============================ list/create ================================

  async list(tenantId: string): Promise<InvitationDto[]> {
    const rows = await this.admin.invitation.findMany({
      where: { tenantId },
      include: { invitedBy: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    inviterUserId: string;
    inviterName: string;
    input: InviteUserInput;
    meta: RequestMeta;
  }): Promise<InvitationDto> {
    const email = args.input.email;

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

    // Si ya hay una invitacion pendiente: 409.
    const pending = await this.admin.invitation.findFirst({
      where: { tenantId: args.tenantId, email, acceptedAt: null, revokedAt: null },
    });
    if (pending) {
      throw new ConflictException({
        message: 'Ya hay una invitacion pendiente para ese email',
        code: 'invitation_pending',
      });
    }

    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: args.tenantId } });
    const { secret, tokenHash } = await this.invitationTokens.hashSecret();
    const expiresAt = this.invitationTokens.buildExpiry();

    const record = await this.admin.invitation.create({
      data: {
        tenantId: args.tenantId,
        email,
        role: args.input.role,
        invitedByUserId: args.inviterUserId,
        tokenHash,
        expiresAt,
      },
      include: { invitedBy: true },
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
      changes: { email, role: args.input.role },
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

    // Invalidar la actual (si estaba pendiente) y crear una nueva con
    // mismo email/role. La que vuelve a salir es la nueva.
    if (original.revokedAt === null) {
      await this.admin.invitation.update({
        where: { id: original.id },
        data: { revokedAt: new Date(), revokedReason: 'replaced_by_resend' },
      });
    }

    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: args.tenantId } });
    const { secret, tokenHash } = await this.invitationTokens.hashSecret();
    const expiresAt = this.invitationTokens.buildExpiry();
    const fresh = await this.admin.invitation.create({
      data: {
        tenantId: args.tenantId,
        email: original.email,
        role: original.role,
        invitedByUserId: args.userId,
        tokenHash,
        expiresAt,
      },
      include: { invitedBy: true },
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
    const user = await this.admin.user.create({
      data: {
        tenantId: record.tenantId,
        email: record.email,
        passwordHash,
        fullName: input.fullName.trim(),
        role: record.role,
        emailVerifiedAt: new Date(),
      },
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
      changes: { role: record.role, viaInvitationId: record.id },
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
    });
    const { token: accessToken, expiresIn } = await this.tokens.signAccess({
      sub: user.id,
      tenantId: record.tenantId,
      // Usuario recién aceptado: nunca tiene rol custom ni locales asignados todavía.
      role: user.role,
      permissions: permissionsForRole(user.role),
      facilityScope: null,
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
        subject: `${inviterName} te ha invitado a ${tenantName} en StorageOS`,
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

  private toDto(record: Invitation & { invitedBy?: { fullName: string } | null }): InvitationDto {
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
      createdAt: record.createdAt.toISOString(),
    };
  }
}
