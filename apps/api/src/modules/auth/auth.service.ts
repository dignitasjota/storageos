import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { AuditService } from './audit.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';

import type { Tenant, TenantSubscription, User } from '@storageos/database';
import type {
  AuthSuccessResponse,
  LoginInput,
  MeResponse,
  RefreshSuccessResponse,
  RegisterInput,
  SubscriptionDto,
  TenantDto,
  UserDto,
  UserRole,
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
  ) {}

  // ============================ register ===================================

  async register(
    input: RegisterInput,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
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
        },
      });
      return { tenant: newTenant, subscription: newSubscription, user: newUser };
    });

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

    return this.emitAuthSuccess(user, tenant, subscription, plan.slug, meta);
  }

  // ============================== login ====================================

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: input.tenantSlug } });
    if (!tenant || tenant.deletedAt) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const user = await this.admin.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
    });
    if (!user) {
      // Login fallido con tenant conocido: audit (sin userId).
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
      throw new UnauthorizedException('Credenciales invalidas');
    }

    if (!user.isActive) {
      throw new ForbiddenException('Cuenta desactivada');
    }

    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId: tenant.id },
      include: { plan: true },
    });
    if (!subscription) {
      this.logger.error(`Tenant ${tenant.id} sin suscripcion`);
      throw new InternalServerErrorException('Configuracion del tenant incompleta');
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

    // El user puede haber sido desactivado entre tanto.
    const user = await this.admin.user.findUnique({ where: { id: result.userId } });
    if (!user || !user.isActive) {
      // Revoca la sesion recien creada para que no quede colgando.
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
    });

    return {
      body: { accessToken, expiresIn },
      refreshToken: result.refreshToken,
    };
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
      return {
        user: this.toUserDto(user),
        tenant: this.toTenantDto(tenant),
        subscription: this.toSubscriptionDto(subscription, subscription.plan.slug),
      };
    }, args.tenantId);
  }

  // ========================== helpers privados =============================

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
