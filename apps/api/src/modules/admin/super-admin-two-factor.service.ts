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
import QRCode from 'qrcode';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { TotpService } from '../two-factor/totp.service';

import { SuperAdminAuditService } from './super-admin-audit.service';
import { SuperAdminSessionsService } from './super-admin-sessions.service';

import type { AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import type { Env } from '../../config/env.schema';
import type {
  SuperAdminDto,
  SuperAdminRecoveryCodesResponse,
  SuperAdminSetup2faResponse,
  SuperAdminTwoFactorStatusResponse,
} from '@storageos/shared';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_BLOCK = 4;
const RECOVERY_CODE_BLOCKS = 2;

function generateRecoveryPlaintext(): string {
  const blocks: string[] = [];
  for (let b = 0; b < RECOVERY_CODE_BLOCKS; b++) {
    const buf = randomBytes(RECOVERY_CODE_BLOCK);
    let block = '';
    for (let i = 0; i < RECOVERY_CODE_BLOCK; i++) {
      block += RECOVERY_CODE_CHARS[buf[i]! % RECOVERY_CODE_CHARS.length];
    }
    blocks.push(block);
  }
  return blocks.join('-');
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}

function isRecoveryCodeShape(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

export interface SuperAdminChallengeResult {
  accessToken: string;
  expiresIn: number;
  admin: SuperAdminDto;
  refreshToken: string;
  refreshTtlSeconds: number;
  method: 'totp' | 'recovery_code';
}

/**
 * Orquesta los flujos 2FA del super admin. Mismas garantias que
 * `TwoFactorService` para tenant users:
 *   - Secret TOTP cifrado en BD con AES-256-GCM (CryptoService).
 *   - 10 recovery codes `XXXX-XXXX` hashed argon2id, single-use.
 *   - Login en dos pasos cuando 2FA esta activo: el primer login devuelve un
 *     `pendingToken` corto firmado con `JWT_2FA_PENDING_SECRET` con
 *     `purpose='superadmin-2fa-pending'`. El cliente llama a
 *     `/admin/auth/2fa/challenge` con ese token + un codigo TOTP o recovery
 *     para canjear sesion real (access + refresh cookie).
 *
 * Las acciones criticas de super admin se LOGUEAN al stdout (logger.log) en
 * lugar de a `audit_logs`, porque `audit_logs.tenant_id` es NOT NULL y los
 * super admins no estan asociados a un tenant. Acciones contra un tenant
 * concreto (impersonation, etc.) si van a `audit_logs`.
 */
@Injectable()
export class SuperAdminTwoFactorService {
  private readonly logger = new Logger(SuperAdminTwoFactorService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly totp: TotpService,
    private readonly jwt: JwtService,
    private readonly sessions: SuperAdminSessionsService,
    private readonly config: ConfigService<Env, true>,
    private readonly auditService: SuperAdminAuditService,
  ) {}

  // ----------------------------- status ------------------------------------

  async status(adminId: string): Promise<SuperAdminTwoFactorStatusResponse> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    const remaining = record.twoFactorEnabled
      ? await this.admin.superAdminRecoveryCode.count({
          where: { superAdminId: adminId, usedAt: null },
        })
      : 0;
    return {
      enabled: record.twoFactorEnabled,
      enrolledAt: record.twoFactorEnrolledAt ? record.twoFactorEnrolledAt.toISOString() : null,
      recoveryCodesRemaining: remaining,
    };
  }

  // ------------------------------ setup ------------------------------------

  async setup(adminId: string): Promise<SuperAdminSetup2faResponse> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (record.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'already_enabled',
        message: '2FA ya esta activado',
      });
    }
    const secret = this.totp.generateSecret();
    const encrypted = this.crypto.encryptString(secret);
    await this.admin.superAdmin.update({
      where: { id: adminId },
      data: { twoFactorPendingSecret: encrypted },
    });
    const otpauthUri = this.totp.buildOtpAuthUri(secret, record.email);
    const qrCode = await QRCode.toDataURL(otpauthUri);
    return {
      otpauthUri,
      secretBase32: secret,
      qrCode,
    };
  }

  // ------------------------------ verify -----------------------------------

  async verify(
    adminId: string,
    code: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<SuperAdminRecoveryCodesResponse> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (record.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'already_enabled',
        message: '2FA ya esta activado',
      });
    }
    if (!record.twoFactorPendingSecret) {
      throw new BadRequestException({
        code: 'setup_required',
        message: 'No hay un setup 2FA en curso',
      });
    }
    const secret = this.crypto.decryptString(record.twoFactorPendingSecret);
    if (!this.totp.verify(secret, code)) {
      throw new ForbiddenException({
        code: 'invalid_code',
        message: 'Codigo invalido',
      });
    }

    const recoveryCodes = await this.issueRecoveryCodes(adminId);
    await this.admin.superAdmin.update({
      where: { id: adminId },
      data: {
        twoFactorSecret: record.twoFactorPendingSecret,
        twoFactorPendingSecret: null,
        twoFactorEnabled: true,
        twoFactorEnrolledAt: new Date(),
      },
    });
    this.logger.log(
      `admin.2fa.enabled adminId=${adminId} ip=${meta.ipAddress ?? '-'} ua=${meta.userAgent ?? '-'}`,
    );
    await this.auditService.record({
      superAdminId: adminId,
      action: 'admin.2fa.enabled',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recoveryCodes };
  }

  // ------------------------------ disable ----------------------------------

  async disable(
    adminId: string,
    password: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<void> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (!record.twoFactorEnabled || !record.twoFactorSecret) {
      throw new BadRequestException({
        code: 'not_enabled',
        message: '2FA no esta activado',
      });
    }
    const passwordOk = await argonVerify(record.passwordHash, password);
    if (!passwordOk) {
      throw new ForbiddenException({
        code: 'wrong_password',
        message: 'Contrasena incorrecta',
      });
    }
    await this.admin.$transaction([
      this.admin.superAdmin.update({
        where: { id: adminId },
        data: {
          twoFactorSecret: null,
          twoFactorPendingSecret: null,
          twoFactorEnabled: false,
          twoFactorEnrolledAt: null,
        },
      }),
      this.admin.superAdminRecoveryCode.deleteMany({ where: { superAdminId: adminId } }),
    ]);
    // Revoca todas las sesiones de refresh: forzamos a re-loguear y, ademas,
    // si el atacante hubiese activado 2FA con un secret robado, se le tira
    // tambien el refresh.
    await this.sessions.revokeAll({ superAdminId: adminId, reason: 'two_factor_disabled' });
    this.logger.log(
      `admin.2fa.disabled adminId=${adminId} ip=${meta.ipAddress ?? '-'} ua=${meta.userAgent ?? '-'}`,
    );
    await this.auditService.record({
      superAdminId: adminId,
      action: 'admin.2fa.disabled',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ---------------------- regenerate recovery codes ------------------------

  async regenerateRecoveryCodes(
    adminId: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<SuperAdminRecoveryCodesResponse> {
    const record = await this.admin.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (!record.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'not_enabled',
        message: '2FA no esta activado',
      });
    }
    const recoveryCodes = await this.issueRecoveryCodes(adminId);
    this.logger.log(
      `admin.2fa.recovery_codes_regenerated adminId=${adminId} ip=${meta.ipAddress ?? '-'} ua=${meta.userAgent ?? '-'}`,
    );
    await this.auditService.record({
      superAdminId: adminId,
      action: 'admin.2fa.recovery_codes_regenerated',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recoveryCodes };
  }

  // ----------------------- pending token + challenge -----------------------

  async issuePendingToken(adminId: string): Promise<{ pendingToken: string; expiresIn: number }> {
    const expiresIn = this.config.get('JWT_2FA_PENDING_TTL_SECONDS', { infer: true });
    const pendingToken = await this.jwt.signAsync(
      { purpose: 'superadmin-2fa-pending' },
      {
        subject: adminId,
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
        expiresIn,
      },
    );
    return { pendingToken, expiresIn };
  }

  async challenge(
    pendingToken: string,
    code: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<SuperAdminChallengeResult> {
    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; purpose: string }>(pendingToken, {
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'invalid_pending_token',
        message: 'Token 2FA invalido o expirado',
      });
    }
    if (payload.purpose !== 'superadmin-2fa-pending') {
      throw new UnauthorizedException({
        code: 'invalid_pending_token',
        message: 'Token con purpose invalido',
      });
    }

    const record = await this.admin.superAdmin.findUnique({ where: { id: payload.sub } });
    if (!record) {
      throw new NotFoundException({
        code: 'super_admin_not_found',
        message: 'Super admin no encontrado',
      });
    }
    if (!record.isActive) {
      throw new ForbiddenException({
        code: 'account_disabled',
        message: 'Cuenta desactivada',
      });
    }
    if (!record.twoFactorEnabled || !record.twoFactorSecret) {
      // El admin desactivo 2FA entre login y challenge: rechazamos limpio.
      throw new ForbiddenException({
        code: 'not_enabled',
        message: '2FA no activo',
      });
    }

    const usedRecovery = isRecoveryCodeShape(code);
    let ok = false;
    if (usedRecovery) {
      ok = await this.consumeRecoveryCode(record.id, code);
    } else {
      try {
        const secret = this.crypto.decryptString(record.twoFactorSecret);
        ok = this.totp.verify(secret, code);
      } catch (err) {
        this.logger.error('Error descifrando secret 2FA del super admin', err as Error);
        ok = false;
      }
    }

    if (!ok) {
      this.logger.warn(
        `admin.2fa.challenge.failed adminId=${record.id} ip=${meta.ipAddress ?? '-'} ua=${meta.userAgent ?? '-'}`,
      );
      await this.auditService.record({
        superAdminId: record.id,
        action: 'admin.2fa.challenge.failed',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        changes: { method: usedRecovery ? 'recovery_code' : 'totp' },
      });
      throw new ForbiddenException({
        code: 'invalid_code',
        message: 'Codigo invalido',
      });
    }
    this.logger.log(
      `admin.2fa.challenge.success adminId=${record.id} method=${usedRecovery ? 'recovery_code' : 'totp'} ip=${meta.ipAddress ?? '-'}`,
    );
    await this.auditService.record({
      superAdminId: record.id,
      action: 'admin.2fa.challenge.success',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { method: usedRecovery ? 'recovery_code' : 'totp' },
    });

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

    return {
      accessToken,
      expiresIn,
      admin: {
        id: record.id,
        email: record.email,
        fullName: record.fullName,
        role: record.role,
        isActive: record.isActive,
        twoFactorEnabled: record.twoFactorEnabled,
        lastLoginAt: new Date().toISOString(),
        createdAt: record.createdAt.toISOString(),
      },
      refreshToken,
      refreshTtlSeconds: this.sessions.getRefreshTtlSeconds(),
      method: usedRecovery ? 'recovery_code' : 'totp',
    };
  }

  // ----------------------- helpers privados --------------------------------

  /**
   * Genera 10 recovery codes plaintext, persiste hashes argon2id y borra los
   * anteriores. Devuelve los plaintext para mostrar UNA VEZ al admin.
   */
  private async issueRecoveryCodes(adminId: string): Promise<string[]> {
    const plaintexts: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const plain = generateRecoveryPlaintext();
      plaintexts.push(plain);
      hashes.push(await argonHash(normalizeRecoveryCode(plain)));
    }
    await this.admin.$transaction([
      this.admin.superAdminRecoveryCode.deleteMany({ where: { superAdminId: adminId } }),
      this.admin.superAdminRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ superAdminId: adminId, codeHash })),
      }),
    ]);
    return plaintexts;
  }

  /**
   * Intenta consumir un recovery code. Devuelve true si el codigo existia,
   * no estaba consumido y se ha marcado como consumido en esta llamada.
   * Implementacion lineal (10 codigos como mucho).
   */
  private async consumeRecoveryCode(adminId: string, plaintext: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(plaintext);
    const candidates = await this.admin.superAdminRecoveryCode.findMany({
      where: { superAdminId: adminId, usedAt: null },
    });
    for (const candidate of candidates) {
      let matches = false;
      try {
        matches = await argonVerify(candidate.codeHash, normalized);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const result = await this.admin.superAdminRecoveryCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 1) return true;
    }
    return false;
  }
}
