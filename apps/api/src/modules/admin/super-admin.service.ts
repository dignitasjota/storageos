import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

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

interface CreateSuperAdminInput {
  email: string;
  password: string;
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
 * La creacion de super admins esta restringida a seed/CLI: no exponemos
 * endpoints publicos para auto-registro. El metodo `create` esta aqui para
 * que el seed lo invoque.
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
    const record = await this.admin.superAdmin.findUnique({ where: { email: input.email } });
    if (!record) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Credenciales invalidas',
      });
    }
    if (!record.isActive) {
      throw new ForbiddenException({
        code: 'account_disabled',
        message: 'Cuenta desactivada',
      });
    }
    const passwordOk = await argonVerify(record.passwordHash, input.password);
    if (!passwordOk) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Credenciales invalidas',
      });
    }

    if (record.twoFactorEnabled) {
      const { pendingToken, expiresIn } = await this.twoFactor.issuePendingToken(record.id);
      this.logger.log(`admin.login.requires_2fa adminId=${record.id} ip=${meta.ipAddress ?? '-'}`);
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
   * Crea un super admin. Pensado para uso desde seed/CLI; no se expone
   * via HTTP en MVP. Para evitar duplicados, si ya existe el email se
   * lanza ConflictException-style con 400 (preferimos no llegar aqui).
   */
  async create(input: CreateSuperAdminInput): Promise<SuperAdminDto> {
    const existing = await this.admin.superAdmin.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ForbiddenException({
        code: 'super_admin_exists',
        message: 'Ya existe un super admin con ese email',
      });
    }
    const passwordHash = await argonHash(input.password);
    const created = await this.admin.superAdmin.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        role: input.role ?? 'support',
      },
    });
    this.logger.log(`Super admin creado: ${created.email} (${created.role})`);
    return this.toDto(created);
  }

  // ============================ helpers ====================================

  toDto(record: SuperAdmin): SuperAdminDto {
    return {
      id: record.id,
      email: record.email,
      fullName: record.fullName,
      role: record.role,
      isActive: record.isActive,
      lastLoginAt: record.lastLoginAt ? record.lastLoginAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
