import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  effectiveFeaturesFromList,
  permissionsForRole,
  resolvePlanFeatures,
} from '@storageos/shared';

import { BUILTIN_TEMPLATES } from '../communications/builtin-templates';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { PasswordResetEmail } from '../email/templates/password-reset-email';
import { VerificationEmail } from '../email/templates/verification-email';
import { SecurityEventsService } from '../security-events/security-events.service';

import { AuditService } from './audit.service';
import { PasswordResetTokensService } from './password-reset-tokens.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';
import { VerificationTokensService } from './verification-tokens.service';

import type { Env } from '../../config/env.schema';
import type { Tenant, TenantSubscription, User } from '@storageos/database';
import type { TenantFeature } from '@storageos/shared';
import type {
  AuthSuccessResponse,
  ForgotPasswordInput,
  LoginInput,
  LoginRequires2faEnrolmentResponse,
  LoginRequires2faResponse,
  MeResponse,
  Permission,
  RefreshSuccessResponse,
  RegisterInput,
  RegisterPendingResponse,
  ResendVerificationInput,
  ResetPasswordInput,
  SubscriptionDto,
  TenantDto,
  UserDto,
  UserRole,
  VerifyEmailInput,
} from '@storageos/shared';

/** Metadatos opcionales del request, propagados a sessions + audit logs. */
export interface RequestMeta {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/** Resultado de los flujos que emiten cookie + body distintos. */
export interface AuthFlowResult<TBody> {
  body: TBody;
  refreshToken: string;
}

const TRIAL_DAYS = 14;
const TRIAL_PLAN_SLUG = 'starter';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly verificationTokens: VerificationTokensService,
    private readonly passwordResetTokens: PasswordResetTokensService,
    private readonly config: ConfigService<Env, true>,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  // Nota: `login_failed_throttled`, `register_throttled` y
  //   `password_reset_throttled` los persiste `SecurityThrottlerGuard`
  //   (extiende `ThrottlerGuard`) cuando el rate-limit corta el request,
  //   no este service. `invitation_token_invalid` sigue pendiente de
  //   instrumentar en `InvitationsService`.

  // ============================ register ===================================

  async register(input: RegisterInput, meta: RequestMeta): Promise<RegisterPendingResponse> {
    const slug = await this.resolveSlug(input.tenantName, input.tenantSlug);

    const plan = await this.admin.subscriptionPlan.findUnique({
      where: { slug: TRIAL_PLAN_SLUG },
    });
    if (!plan) {
      this.logger.error(`Plan "${TRIAL_PLAN_SLUG}" no encontrado; corre pnpm db:seed`);
      throw new InternalServerErrorException('Configuracion de planes incompleta');
    }

    const passwordHash = await argonHash(input.password);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const { tenant, user, subscription } = await this.admin.$transaction(async (tx) => {
      const newTenant = await tx.tenant.create({
        data: {
          name: input.tenantName.trim(),
          slug,
          status: 'trial',
          trialEndsAt,
          billingEmail: input.email,
        },
      });
      const newSubscription = await tx.tenantSubscription.create({
        data: {
          tenantId: newTenant.id,
          planId: plan.id,
          status: 'trial',
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt,
        },
      });
      const newUser = await tx.user.create({
        data: {
          tenantId: newTenant.id,
          email: input.email,
          passwordHash,
          fullName: input.fullName.trim(),
          role: 'owner',
          // email_verified_at queda NULL hasta que el usuario verifique.
        },
      });
      // Siembra las plantillas transaccionales del tenant (bienvenida, factura
      // vencida, contrato firmado, PIN de acceso, review…) para que los emails
      // del ciclo de vida funcionen y sean editables en /message-templates.
      // Atómico con el alta; el `enqueue` también cae a `BUILTIN_TEMPLATES` como
      // red de seguridad si por lo que sea faltara alguna fila.
      await tx.messageTemplate.createMany({
        data: BUILTIN_TEMPLATES.map((b) => ({
          tenantId: newTenant.id,
          code: b.code,
          kind: b.kind,
          channel: b.channel,
          name: b.name,
          subject: b.subject,
          bodyText: b.bodyText,
          bodyHtml: b.bodyHtml,
          locale: b.locale,
          variables: b.variables,
          metadata: b.trigger ? { trigger: b.trigger } : {},
        })),
        skipDuplicates: true,
      });
      return { tenant: newTenant, subscription: newSubscription, user: newUser };
    });

    // Token de verificacion + email. El tenant + usuario YA estan creados
    // (commit de la $transaction de arriba), asi que un fallo de email NO debe
    // tumbar el alta con 500 ni dejar la cuenta huerfana: lo registramos y
    // seguimos. El usuario puede pedir el reenvio en POST /auth/resend-verification
    // una vez el proveedor de email este operativo.
    try {
      await this.sendVerificationEmail(tenant, user);
    } catch (err) {
      this.logger.error(
        `[register] tenant ${tenant.slug} creado pero fallo el email de verificacion ` +
          `(${err instanceof Error ? err.message : String(err)}); el usuario podra reenviar`,
      );
    }

    await this.audit.write({
      tenantId: tenant.id,
      userId: user.id,
      action: 'auth.register',
      entityType: 'Tenant',
      entityId: tenant.id,
      changes: { name: tenant.name, slug: tenant.slug, ownerId: user.id },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return {
      user: this.toUserDto(user),
      tenant: this.toTenantDto(tenant),
      subscription: this.toSubscriptionDto(subscription, plan.slug),
      requiresEmailVerification: true,
    };
  }

  // ============================== login ====================================

  async login(
    input: LoginInput,
    meta: RequestMeta,
  ): Promise<
    | AuthFlowResult<AuthSuccessResponse>
    | { body: LoginRequires2faResponse }
    | { body: LoginRequires2faEnrolmentResponse }
  > {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (!tenant || tenant.deletedAt) {
      // Sin tenant_id: el evento no puede ir a audit_logs. Lo persistimos
      // en `security_events` (tabla global) para deteccion de scanning.
      await this.securityEvents.record({
        eventType: 'login_failed_tenant_not_found',
        emailAttempted: input.email,
        tenantSlugAttempted: input.tenantSlug,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const user = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
    });
    if (!user) {
      await this.audit.write({
        tenantId: tenant.id,
        userId: null,
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: null,
        changes: { reason: 'unknown_email', email: input.email },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.securityEvents.record({
        eventType: 'login_failed_email_not_found',
        emailAttempted: input.email,
        tenantSlugAttempted: input.tenantSlug,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const passwordOk = await argonVerify(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.audit.write({
        tenantId: tenant.id,
        userId: user.id,
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: user.id,
        changes: { reason: 'wrong_password' },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.securityEvents.record({
        eventType: 'login_failed_wrong_password',
        emailAttempted: input.email,
        tenantSlugAttempted: input.tenantSlug,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException('Credenciales invalidas');
    }

    if (!user.isActive) {
      throw new ForbiddenException({
        message: 'Cuenta desactivada',
        code: 'account_disabled',
      });
    }

    if (!user.emailVerifiedAt) {
      await this.audit.write({
        tenantId: tenant.id,
        userId: user.id,
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: user.id,
        changes: { reason: 'email_not_verified' },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      throw new ForbiddenException({
        message: 'Email no verificado',
        code: 'email_not_verified',
      });
    }

    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId: tenant.id },
      include: { plan: true },
    });
    if (!subscription) {
      this.logger.error(`Tenant ${tenant.id} sin suscripcion`);
      throw new InternalServerErrorException('Configuracion del tenant incompleta');
    }

    // 2FA: si esta activo, NO emitimos sesion todavia. Devolvemos un
    // pendingToken corto y el frontend debe llamar a /auth/2fa/challenge.
    if (user.twoFactorEnabled) {
      const { token: pendingToken, expiresIn } = await this.tokens.sign2faPending(
        user.id,
        tenant.id,
      );
      return {
        body: {
          requires2fa: true,
          pendingToken,
          expiresIn,
        },
      };
    }

    // Fase 12A.1: politica `requireTwoFactorForManagers`. Si el tenant exige
    // 2FA y el user es owner|manager pero no lo tiene activo, NO emitimos
    // tokens; devolvemos un `enrolmentToken` para forzar el setup.
    if (tenant.requireTwoFactorForManagers && (user.role === 'owner' || user.role === 'manager')) {
      const role = user.role as UserRole;
      const { token: enrolmentToken, expiresIn } = await this.tokens.sign2faEnrolmentRequired(
        user.id,
        tenant.id,
        role,
      );
      await this.audit.write({
        tenantId: tenant.id,
        userId: user.id,
        action: 'auth.2fa.enrolment_required.issued',
        entityType: 'User',
        entityId: user.id,
        changes: { role },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return {
        body: {
          requires2faEnrolment: true,
          enrolmentToken,
          expiresIn,
        },
      };
    }

    await this.admin.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.write({
      tenantId: tenant.id,
      userId: user.id,
      action: 'auth.login.success',
      entityType: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.emitAuthSuccess(user, tenant, subscription, subscription.plan.slug, meta);
  }

  /**
   * Completa el login tras superar el challenge 2FA. Asume que el caller ya
   * verifico el codigo TOTP o recovery; aqui solo emitimos la sesion real
   * y actualizamos `lastLoginAt` + audit log.
   */
  async completeLoginAfter2fa(
    userId: string,
    tenantId: string,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const user = await this.admin.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId || !user.isActive || !user.emailVerifiedAt) {
      throw new UnauthorizedException('Credenciales invalidas');
    }
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new UnauthorizedException('Credenciales invalidas');
    }
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new InternalServerErrorException('Configuracion del tenant incompleta');
    }
    await this.admin.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.write({
      tenantId,
      userId: user.id,
      action: 'auth.login.success',
      entityType: 'User',
      entityId: user.id,
      changes: { method: '2fa' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.emitAuthSuccess(user, tenant, subscription, subscription.plan.slug, meta);
  }

  /**
   * Completa el login tras superar el enrolment 2FA forzoso. Reutiliza la
   * misma logica de carga + audit log que `completeLoginAfter2fa`, pero
   * con un `action` distinto en el audit log para diferenciar el flujo.
   */
  async completeLoginAfterEnrolment(
    userId: string,
    tenantId: string,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const user = await this.admin.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId || !user.isActive || !user.emailVerifiedAt) {
      throw new UnauthorizedException('Credenciales invalidas');
    }
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new UnauthorizedException('Credenciales invalidas');
    }
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new InternalServerErrorException('Configuracion del tenant incompleta');
    }
    await this.admin.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.write({
      tenantId,
      userId: user.id,
      action: 'auth.login.success',
      entityType: 'User',
      entityId: user.id,
      changes: { method: '2fa_enrolment_required' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.emitAuthSuccess(user, tenant, subscription, subscription.plan.slug, meta);
  }

  // ============================ refresh ====================================

  async refresh(
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<RefreshSuccessResponse>> {
    const result = await this.sessions.rotate({
      refreshToken,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    const user = await this.admin.user.findUnique({ where: { id: result.userId } });
    if (!user || !user.isActive || !user.emailVerifiedAt) {
      await this.sessions.revoke({
        tenantId: result.tenantId,
        sessionId: result.session.id,
        reason: 'logout',
      });
      throw new UnauthorizedException('Cuenta no disponible');
    }

    await this.audit.write({
      tenantId: result.tenantId,
      userId: result.userId,
      action: 'auth.refresh',
      entityType: 'Session',
      entityId: result.session.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const { token: accessToken, expiresIn } = await this.tokens.signAccess({
      sub: user.id,
      tenantId: result.tenantId,
      role: user.role,
      permissions: await this.resolvePermissions(result.tenantId, user),
      facilityScope: await this.resolveFacilityScope(result.tenantId, user.id),
    });

    return {
      body: { accessToken, expiresIn },
      refreshToken: result.refreshToken,
    };
  }

  // ========================= verify email ==================================

  async verifyEmail(
    input: VerifyEmailInput,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const record = await this.verificationTokens.consume(input.token);
    if (!record) {
      throw new UnauthorizedException('Token de verificacion invalido o caducado');
    }

    const user = await this.admin.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    });

    await this.audit.write({
      tenantId: record.tenantId,
      userId: user.id,
      action: 'auth.verification.success',
      entityType: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const tenant = await this.admin.tenant.findUniqueOrThrow({ where: { id: record.tenantId } });
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId: tenant.id },
      include: { plan: true },
    });
    if (!subscription) {
      throw new InternalServerErrorException('Suscripcion no encontrada');
    }

    return this.emitAuthSuccess(user, tenant, subscription, subscription.plan.slug, meta);
  }

  async resendVerification(input: ResendVerificationInput): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (!tenant) return;
    const user = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
    });
    if (!user || user.emailVerifiedAt || !user.isActive) return;

    await this.sendVerificationEmail(tenant, user, { source: 'resend' });
  }

  // ========================= password reset ================================

  async forgotPassword(input: ForgotPasswordInput, meta: RequestMeta): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (!tenant) return;
    const user = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
    });
    if (!user || !user.isActive) return;

    const { plaintext } = await this.passwordResetTokens.issue({
      tenantId: tenant.id,
      userId: user.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    const baseUrl = this.config.get('WEB_BASE_URL', { infer: true });
    const resetUrl = `${baseUrl}/reset-password/${plaintext}`;

    await this.email.send({
      to: user.email,
      subject: 'Restablece tu contrasena de TrasterOS',
      template: PasswordResetEmail({
        fullName: user.fullName,
        resetUrl,
        ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      }),
    });

    await this.audit.write({
      tenantId: tenant.id,
      userId: user.id,
      action: 'auth.password_reset.requested',
      entityType: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<void> {
    const record = await this.passwordResetTokens.consume(input.token);
    if (!record) {
      throw new UnauthorizedException('Token invalido o caducado');
    }

    const newHash = await argonHash(input.password);
    await this.admin.user.update({
      where: { id: record.userId },
      data: { passwordHash: newHash },
    });

    // Revocar TODAS las sesiones del usuario tras cambiar la contrasena.
    await this.sessions.revokeAllForUser({
      tenantId: record.tenantId,
      userId: record.userId,
      reason: 'logout_all',
    });

    await this.audit.write({
      tenantId: record.tenantId,
      userId: record.userId,
      action: 'auth.password_reset.completed',
      entityType: 'User',
      entityId: record.userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ============================ logout =====================================

  async logout(args: { tenantId: string; userId: string; sessionId: string }): Promise<void> {
    await this.sessions.revoke({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      reason: 'logout',
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: args.sessionId,
    });
  }

  async logoutAll(args: { tenantId: string; userId: string }): Promise<{ revokedCount: number }> {
    const revokedCount = await this.sessions.revokeAllForUser({
      tenantId: args.tenantId,
      userId: args.userId,
      reason: 'logout_all',
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: args.userId,
      changes: { revokedCount },
    });
    return { revokedCount };
  }

  // ============================== me =======================================

  async me(args: { tenantId: string; userId: string }): Promise<MeResponse> {
    return this.prisma.withTenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: args.userId } });
      if (!user) throw new NotFoundException('Usuario no encontrado');
      const tenant = await tx.tenant.findUnique({ where: { id: args.tenantId } });
      if (!tenant) throw new NotFoundException('Tenant no encontrado');
      const subscription = await tx.tenantSubscription.findUnique({
        where: { tenantId: args.tenantId },
        include: { plan: true },
      });
      if (!subscription) {
        throw new InternalServerErrorException('Suscripcion no encontrada');
      }
      const overrides = await tx.tenantFeatureOverride.findMany({
        where: { tenantId: args.tenantId },
        select: { feature: true, enabled: true },
      });
      return {
        user: this.toUserDto(user),
        tenant: this.toTenantDto(tenant),
        subscription: this.toSubscriptionDto(subscription, subscription.plan.slug),
        permissions: await this.resolvePermissions(args.tenantId, user),
        features: effectiveFeaturesFromList(
          resolvePlanFeatures(subscription.plan),
          overrides as { feature: TenantFeature; enabled: boolean }[],
        ),
        facilityScope: await this.resolveFacilityScope(args.tenantId, args.userId),
      };
    }, args.tenantId);
  }

  /**
   * Locales a los que está restringido un usuario (permisos por local). Sin
   * asignaciones en `user_facilities` → null (ve todos los locales del tenant).
   */
  private async resolveFacilityScope(tenantId: string, userId: string): Promise<string[] | null> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.userFacility.findMany({ where: { userId }, select: { facilityId: true } }),
      tenantId,
    );
    return rows.length > 0 ? rows.map((r) => r.facilityId) : null;
  }

  // ========================== helpers privados =============================

  /**
   * Permisos efectivos de un usuario: si tiene un rol custom asignado
   * (`tenantRoleId`), sus permisos; si no, los del rol enum. Se resuelve al
   * emitir el access token y en `/auth/me`.
   */
  private async resolvePermissions(
    tenantId: string,
    user: { role: UserRole; tenantRoleId: string | null },
  ): Promise<Permission[]> {
    if (user.tenantRoleId) {
      const customRole = await this.prisma.withTenant(
        (tx) => tx.tenantRole.findUnique({ where: { id: user.tenantRoleId! } }),
        tenantId,
      );
      if (customRole) return customRole.permissions as Permission[];
    }
    return permissionsForRole(user.role);
  }

  private async sendVerificationEmail(
    tenant: Tenant,
    user: User,
    extra?: { source?: 'register' | 'resend' },
  ): Promise<void> {
    const { plaintext } = await this.verificationTokens.issue({
      tenantId: tenant.id,
      userId: user.id,
    });
    const baseUrl = this.config.get('WEB_BASE_URL', { infer: true });
    const verifyUrl = `${baseUrl}/verify-email/${plaintext}`;

    await this.email.send({
      to: user.email,
      subject: 'Verifica tu cuenta de TrasterOS',
      template: VerificationEmail({ fullName: user.fullName, verifyUrl }),
    });

    await this.audit.write({
      tenantId: tenant.id,
      userId: user.id,
      action: 'auth.verification.sent',
      entityType: 'User',
      entityId: user.id,
      ...(extra?.source ? { changes: { source: extra.source } } : {}),
    });
  }

  private async resolveSlug(tenantName: string, requestedSlug?: string): Promise<string> {
    if (requestedSlug) {
      const taken = await this.admin.tenant.findUnique({ where: { slug: requestedSlug } });
      if (taken) {
        throw new ConflictException('Ese slug ya esta en uso');
      }
      return requestedSlug;
    }
    const base = slugify(tenantName);
    if (!base) {
      throw new ConflictException('No se pudo generar un slug a partir del nombre');
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.admin.tenant.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    throw new ConflictException('No se pudo encontrar un slug libre');
  }

  private async emitAuthSuccess(
    user: User,
    tenant: Tenant,
    subscription: TenantSubscription,
    planSlug: string,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const { refreshToken } = await this.sessions.createForLogin({
      tenantId: tenant.id,
      userId: user.id,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });
    const { token: accessToken, expiresIn } = await this.tokens.signAccess({
      sub: user.id,
      tenantId: tenant.id,
      role: user.role,
      permissions: await this.resolvePermissions(tenant.id, user),
      facilityScope: await this.resolveFacilityScope(tenant.id, user.id),
    });

    return {
      body: {
        user: this.toUserDto(user),
        tenant: this.toTenantDto(tenant),
        subscription: this.toSubscriptionDto(subscription, planSlug),
        accessToken,
        expiresIn,
      },
      refreshToken,
    };
  }

  private toUserDto(user: User): UserDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone ?? null,
      role: user.role as UserRole,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  }

  private toTenantDto(tenant: Tenant): TenantDto {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
      locale: tenant.locale,
      currency: tenant.currency,
      timezone: tenant.timezone,
    };
  }

  private toSubscriptionDto(sub: TenantSubscription, planSlug: string): SubscriptionDto {
    return {
      status: sub.status,
      planSlug,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }
}

/**
 * Transforma un nombre arbitrario en un slug kebab-case ASCII.
 * Reemplaza acentos, mantiene digitos y letras, colapsa guiones.
 */
function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
