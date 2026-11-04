import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { renderAdminEmail } from '@storageos/shared';

import { verifyAgainstDummyHash } from '../../common/security/dummy-password';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { SecurityBlocksService } from '../security-events/security-blocks.service';
import { SecurityEventsService } from '../security-events/security-events.service';

import { SuperAdminAuditService } from './super-admin-audit.service';
import { SuperAdminSessionsService } from './super-admin-sessions.service';
import { SuperAdminTwoFactorService } from './super-admin-two-factor.service';

import type { AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import type { Env } from '../../config/env.schema';
import type { SuperAdmin } from '@storageos/database';
import type {
  SuperAdminDto,
  SuperAdminLoginInput,
  SuperAdminLoginRequires2faResponse,
  SuperAdminRoleValue,
  SuperAdminSessionDto,
} from '@storageos/shared';

/** El enlace de recuperar la contraseña caduca pronto; el de la invitación, a los días. */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CreateSuperAdminInput {
  email: string;
  /** Sin contraseña se le envía un enlace para que la elija. */
  password?: string | undefined;
  fullName: string;
  role?: SuperAdminRoleValue;
}

export interface SuperAdminLoginMeta {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** Resultado del login con cookie httpOnly de refresh. */
export interface SuperAdminLoginSuccessResult {
  body: SuperAdminSessionDto;
  refreshToken: string;
  refreshTtlSeconds: number;
}

/** Login que requiere completar 2FA: NO se emite refresh todavia. */
export interface SuperAdminLoginPendingResult {
  body: SuperAdminLoginRequires2faResponse;
}

export type SuperAdminLoginResult = SuperAdminLoginSuccessResult | SuperAdminLoginPendingResult;

/**
 * Gestion de super administradores: login, lookup y CRUD basico.
 *
 * Los super admins viven en la tabla global `super_admins` (sin tenantId).
 * Su autenticacion es completamente independiente de la de los tenant users
 * y se firma con `SUPER_ADMIN_JWT_SECRET` + purpose='superadmin'.
 *
 * No hay auto-registro: los crea el seed/CLI o un super admin desde el panel.
 */
@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly sessions: SuperAdminSessionsService,
    private readonly twoFactor: SuperAdminTwoFactorService,
    private readonly audit: SuperAdminAuditService,
    private readonly securityEvents: SecurityEventsService,
    private readonly email: EmailService,
    private readonly blocks: SecurityBlocksService,
  ) {}

  // =============================== login ===================================

  /**
   * Login del super admin.
   *
   *   - Si el admin tiene `twoFactorEnabled=true`, devolvemos
   *     `{ requires2fa: true, pendingToken, expiresIn }` y NO emitimos
   *     sesion. El cliente debe llamar a `/admin/auth/2fa/challenge` con
   *     el `pendingToken` + un codigo TOTP o recovery code.
   *   - Si NO tiene 2FA, devolvemos `accessToken` + creamos un
   *     `SuperAdminSession` cuyo refresh token devolvemos al controller
   *     para que lo guarde en cookie httpOnly `super_admin_refresh`.
   */
  async login(
    input: SuperAdminLoginInput,
    meta: SuperAdminLoginMeta = {},
  ): Promise<SuperAdminLoginResult> {
    await this.blocks.assertAllowed({ email: input.email, ...meta });
    const record = await this.admin.superAdmin.findUnique({ where: { email: input.email } });
    if (!record) {
      // No autenticado: superAdminId queda null pero registramos el intento
      // con el email para auditoria.
      await this.audit.record({
        action: 'admin.login.failed',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        changes: { email: input.email, reason: 'email_not_found' },
      });
      await this.recordFailedLogin(input.email, 'email_not_found', meta);
      await verifyAgainstDummyHash(input.password); // mismo coste que un login real
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Credenciales invalidas',
      });
    }
    const passwordOk = await argonVerify(record.passwordHash, input.password);
    if (!passwordOk) {
      await this.audit.record({
        superAdminId: record.id,
        action: 'admin.login.failed',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        changes: { email: input.email, reason: 'wrong_password' },
      });
      await this.recordFailedLogin(input.email, 'wrong_password', meta);
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Credenciales invalidas',
      });
    }
    // El estado de la cuenta se comprueba DESPUÉS de la contraseña: si no,
    // un 403 `account_disabled` revelaba que el email existe sin conocer la clave.
    if (!record.isActive) {
      await this.audit.record({
        superAdminId: record.id,
        action: 'admin.login.failed',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        changes: { email: input.email, reason: 'account_disabled' },
      });
      await this.recordFailedLogin(input.email, 'account_disabled', meta);
      throw new ForbiddenException({
        code: 'account_disabled',
        message: 'Cuenta desactivada',
      });
    }

    if (record.twoFactorEnabled) {
      const { pendingToken, expiresIn } = await this.twoFactor.issuePendingToken(record.id);
      this.logger.log(`admin.login.requires_2fa adminId=${record.id} ip=${meta.ipAddress ?? '-'}`);
      await this.audit.record({
        superAdminId: record.id,
        action: 'admin.login.requires_2fa',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return {
        body: {
          requires2fa: true,
          pendingToken,
          expiresIn,
        },
      };
    }

    await this.admin.superAdmin.update({
      where: { id: record.id },
      data: { lastLoginAt: new Date() },
    });

    const expiresIn = this.config.get('SUPER_ADMIN_JWT_TTL_SECONDS', { infer: true });
    const accessToken = await this.jwt.signAsync(
      {
        email: record.email,
        role: record.role,
        purpose: 'superadmin',
      } satisfies Omit<AuthenticatedSuperAdmin, 'sub' | 'iat' | 'exp'>,
      {
        subject: record.id,
        secret: this.config.get('SUPER_ADMIN_JWT_SECRET', { infer: true }),
        expiresIn,
      },
    );

    const { refreshToken } = await this.sessions.createSession({
      superAdminId: record.id,
      ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      ...(meta.ipAddress !== undefined ? { ipAddress: meta.ipAddress } : {}),
    });
    this.logger.log(`admin.login.success adminId=${record.id} ip=${meta.ipAddress ?? '-'}`);
    await this.audit.record({
      superAdminId: record.id,
      action: 'admin.login.success',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return {
      body: {
        accessToken,
        expiresIn,
        admin: this.toDto(record),
      },
      refreshToken,
      refreshTtlSeconds: this.sessions.getRefreshTtlSeconds(),
    };
  }

  /**
   * Emite un nuevo access token tras rotar el refresh. El controller se
   * encarga de leer la cookie y reescribirla con el nuevo refresh.
   */
  async refreshAccessToken(
    refreshToken: string,
    meta: SuperAdminLoginMeta = {},
  ): Promise<{
    accessToken: string;
    expiresIn: number;
    refreshToken: string;
    refreshTtlSeconds: number;
  }> {
    const result = await this.sessions.rotateSession({
      refreshToken,
      ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      ...(meta.ipAddress !== undefined ? { ipAddress: meta.ipAddress } : {}),
    });
    const record = await this.admin.superAdmin.findUnique({
      where: { id: result.superAdminId },
    });
    if (!record || !record.isActive) {
      await this.sessions.revokeSession({ sessionId: result.session.id, reason: 'logout' });
      throw new UnauthorizedException({
        code: 'account_disabled',
        message: 'Cuenta no disponible',
      });
    }
    const expiresIn = this.config.get('SUPER_ADMIN_JWT_TTL_SECONDS', { infer: true });
    const accessToken = await this.jwt.signAsync(
      {
        email: record.email,
        role: record.role,
        purpose: 'superadmin',
      } satisfies Omit<AuthenticatedSuperAdmin, 'sub' | 'iat' | 'exp'>,
      {
        subject: record.id,
        secret: this.config.get('SUPER_ADMIN_JWT_SECRET', { infer: true }),
        expiresIn,
      },
    );
    this.logger.log(`admin.session.refreshed adminId=${record.id} ip=${meta.ipAddress ?? '-'}`);
    return {
      accessToken,
      expiresIn,
      refreshToken: result.refreshToken,
      refreshTtlSeconds: this.sessions.getRefreshTtlSeconds(),
    };
  }

  // ============================== lookup ===================================

  async getById(id: string): Promise<SuperAdminDto> {
    const record = await this.admin.superAdmin.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException({
        code: 'super_admin_not_found',
        message: 'Super admin no encontrado',
      });
    }
    return this.toDto(record);
  }

  async list(): Promise<SuperAdminDto[]> {
    const rows = await this.admin.superAdmin.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  // ============================== create ===================================

  /**
   * Crea un super admin. Sin contraseña se le genera una al azar que nadie
   * conoce y recibe un enlace para elegir la suya.
   */
  async create(input: CreateSuperAdminInput): Promise<SuperAdminDto> {
    const existing = await this.admin.superAdmin.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ForbiddenException({
        code: 'super_admin_exists',
        message: 'Ya existe un super admin con ese email',
      });
    }
    const passwordHash = await argonHash(input.password ?? randomBytes(32).toString('base64url'));
    const created = await this.admin.superAdmin.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        role: input.role ?? 'support',
      },
    });
    this.logger.log(`Super admin creado: ${created.email} (${created.role})`);
    if (!input.password) await this.sendInvitation(created);
    return this.toDto(created);
  }

  // ============================ contraseña =================================

  /** Pide la actual y cierra todas las sesiones: hay que volver a entrar. */
  async changePassword(
    adminId: string,
    input: { currentPassword: string; newPassword: string },
    meta: SuperAdminLoginMeta = {},
  ): Promise<void> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (!(await argonVerify(record.passwordHash, input.currentPassword))) {
      throw new ForbiddenException({
        code: 'wrong_password',
        message: 'La contraseña actual no es correcta',
      });
    }
    await this.storePassword(adminId, input.newPassword);
    await this.audit.record({
      superAdminId: adminId,
      action: 'admin.password.changed',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /** Nunca dice si el email existe: la respuesta es la misma en todos los casos. */
  async requestPasswordReset(email: string, meta: SuperAdminLoginMeta = {}): Promise<void> {
    const record = await this.admin.superAdmin.findUnique({ where: { email } });
    if (!record || !record.isActive) return;
    const url = await this.issuePasswordLink(record.id, PASSWORD_RESET_TTL_MS);
    const { html, text } = renderAdminEmail(
      [
        `Hola, ${record.fullName}:`,
        'Has pedido cambiar tu contraseña del panel de administración de TrasterOS.',
        `[[boton: Elegir una contraseña nueva | ${url}]]`,
        'El enlace caduca en 1 hora. Si no lo has pedido tú, ignora este correo y tu contraseña seguirá igual.',
      ].join('\n\n'),
    );
    await this.email.sendRendered({
      to: record.email,
      kind: 'password_reset',
      subject: 'Cambia tu contraseña del panel de TrasterOS',
      html,
      text,
    });
    await this.audit.record({
      superAdminId: record.id,
      action: 'admin.password.reset_requested',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /** El enlace vale una vez y cierra todas las sesiones abiertas. */
  async resetPassword(
    input: { token: string; newPassword: string },
    meta: SuperAdminLoginMeta = {},
  ): Promise<void> {
    const invalid = new BadRequestException({
      code: 'invalid_token',
      message: 'El enlace no es válido o ha caducado',
    });
    const [adminId, secret] = input.token.split('.');
    if (!adminId || !secret || !/^[0-9a-f-]{36}$/i.test(adminId)) throw invalid;
    const record = await this.admin.superAdmin.findUnique({ where: { id: adminId } });
    if (
      !record ||
      !record.isActive ||
      !record.passwordResetTokenHash ||
      !record.passwordResetExpiresAt ||
      record.passwordResetExpiresAt.getTime() < Date.now() ||
      !(await argonVerify(record.passwordResetTokenHash, secret))
    ) {
      throw invalid;
    }
    // Dos envíos a la vez con el mismo enlace: solo gana uno.
    const claimed = await this.admin.superAdmin.updateMany({
      where: { id: adminId, passwordResetTokenHash: record.passwordResetTokenHash },
      data: { passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });
    if (claimed.count !== 1) throw invalid;
    await this.storePassword(adminId, input.newPassword);
    await this.audit.record({
      superAdminId: adminId,
      action: 'admin.password.reset',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private async storePassword(adminId: string, password: string): Promise<void> {
    await this.admin.superAdmin.update({
      where: { id: adminId },
      data: {
        passwordHash: await argonHash(password),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });
    await this.sessions.revokeAll({ superAdminId: adminId, reason: 'password_changed' });
  }

  private async issuePasswordLink(adminId: string, ttlMs: number): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    await this.admin.superAdmin.update({
      where: { id: adminId },
      data: {
        passwordResetTokenHash: await argonHash(secret),
        passwordResetExpiresAt: new Date(Date.now() + ttlMs),
      },
    });
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    return `${webBase}/admin/reset-password/${adminId}.${secret}`;
  }

  private async sendInvitation(record: SuperAdmin): Promise<void> {
    const url = await this.issuePasswordLink(record.id, INVITATION_TTL_MS);
    const { html, text } = renderAdminEmail(
      [
        `Hola, ${record.fullName}:`,
        'Te han dado acceso al panel de administración de TrasterOS.',
        `[[boton: Elegir mi contraseña | ${url}]]`,
        'El enlace caduca en 7 días.',
      ].join('\n\n'),
    );
    await this.email.sendRendered({
      to: record.email,
      kind: 'invitation',
      subject: 'Tu acceso al panel de TrasterOS',
      html,
      text,
    });
  }

  private recordFailedLogin(
    email: string,
    reason: string,
    meta: SuperAdminLoginMeta,
  ): Promise<void> {
    return this.securityEvents.record({
      eventType: 'admin_login_failed',
      emailAttempted: email,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      reason,
    });
  }

  /**
   * Activa/desactiva un super admin. No permite modificarse a sí mismo ni
   * desactivar al último super admin con rol `superadmin` (evita lock-out).
   * Al desactivar, revoca sus sesiones.
   */
  async setActive(args: {
    actorId: string;
    targetId: string;
    isActive: boolean;
  }): Promise<SuperAdminDto> {
    const target = await this.admin.superAdmin.findUnique({ where: { id: args.targetId } });
    if (!target) {
      throw new NotFoundException({ code: 'super_admin_not_found', message: 'No encontrado' });
    }
    if (args.targetId === args.actorId) {
      throw new BadRequestException({
        code: 'cannot_modify_self',
        message: 'No puedes modificar tu propia cuenta',
      });
    }
    if (!args.isActive && target.isActive && target.role === 'superadmin') {
      const activeSuperadmins = await this.admin.superAdmin.count({
        where: { isActive: true, role: 'superadmin' },
      });
      if (activeSuperadmins <= 1) {
        throw new BadRequestException({
          code: 'last_super_admin',
          message: 'No puedes desactivar al último super admin',
        });
      }
    }
    const updated = await this.admin.superAdmin.update({
      where: { id: args.targetId },
      data: { isActive: args.isActive },
    });
    if (!args.isActive) {
      await this.admin.superAdminSession.deleteMany({ where: { superAdminId: args.targetId } });
    }
    return this.toDto(updated);
  }

  /** Cambia el rol. Nadie se cambia el suyo ni se queda la plataforma sin superadmin. */
  async setRole(args: {
    actorId: string;
    targetId: string;
    role: SuperAdminRoleValue;
  }): Promise<SuperAdminDto> {
    const target = await this.admin.superAdmin.findUnique({ where: { id: args.targetId } });
    if (!target) {
      throw new NotFoundException({ code: 'super_admin_not_found', message: 'No encontrado' });
    }
    if (args.targetId === args.actorId) {
      throw new BadRequestException({
        code: 'cannot_modify_self',
        message: 'No puedes cambiar tu propio rol',
      });
    }
    if (target.role === 'superadmin' && args.role !== 'superadmin' && target.isActive) {
      const activeSuperadmins = await this.admin.superAdmin.count({
        where: { isActive: true, role: 'superadmin' },
      });
      if (activeSuperadmins <= 1) {
        throw new BadRequestException({
          code: 'last_super_admin',
          message: 'Tiene que quedar al menos un super admin',
        });
      }
    }
    const updated = await this.admin.superAdmin.update({
      where: { id: args.targetId },
      data: { role: args.role },
    });
    return this.toDto(updated);
  }

  // ============================ helpers ====================================

  toDto(record: SuperAdmin): SuperAdminDto {
    return {
      id: record.id,
      email: record.email,
      fullName: record.fullName,
      role: record.role,
      isActive: record.isActive,
      twoFactorEnabled: record.twoFactorEnabled,
      lastLoginAt: record.lastLoginAt ? record.lastLoginAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
