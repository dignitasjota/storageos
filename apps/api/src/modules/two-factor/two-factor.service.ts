import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { verify as argonVerify } from '@node-rs/argon2';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { AuthService, type RequestMeta } from '../auth/auth.service';
import { TokensService } from '../auth/tokens.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { RecoveryCodesService } from './recovery-codes.service';
import { TotpService } from './totp.service';

import type { AuthFlowResult } from '../auth/auth.service';
import type {
  AuthSuccessResponse,
  Challenge2faInput,
  Disable2faInput,
  Enrol2faRequiredSetupInput,
  Enrol2faRequiredVerifyInput,
  Regenerate2faRecoveryCodesInput,
  Setup2faResponse,
  TwoFactorStatusResponse,
} from '@storageos/shared';

/**
 * Orquesta los flujos 2FA. El secret TOTP esta cifrado en BD (AES-256-GCM,
 * `CryptoService`); este servicio es el unico punto donde se descifra para
 * verificar un codigo. Los recovery codes los gestiona `RecoveryCodesService`.
 *
 * Flujo de enrolment:
 *   1. setup(): genera secret nuevo, lo guarda CIFRADO en
 *      `users.two_factor_pending_secret`. Devuelve URI + base32 al frontend.
 *   2. verify(): el user envia el primer codigo. Si valida:
 *      - mueve pending_secret -> two_factor_secret (cifrado),
 *      - marca two_factor_enabled = true,
 *      - emite los 10 recovery codes en plaintext UNA VEZ.
 *
 * Flujo de challenge en login:
 *   /auth/2fa/challenge recibe el pendingToken + codigo TOTP o recovery code
 *   y, si todo OK, llama a `AuthService.completeLoginAfter2fa` para emitir
 *   la sesion real.
 *
 * Flujo de disable: requiere currentPassword + (codigo TOTP O recovery code).
 * Borra el secret y todos los recovery codes; deja `two_factor_enrolled_at`
 * historico a null para reflejar el estado actual.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly totp: TotpService,
    private readonly recovery: RecoveryCodesService,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly tokens: TokensService,
  ) {}

  async status(userId: string): Promise<TwoFactorStatusResponse> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
    const remaining = user.twoFactorEnabled ? await this.recovery.remainingForUser(userId) : 0;
    return {
      enabled: user.twoFactorEnabled,
      enrolledAt: user.twoFactorEnrolledAt ? user.twoFactorEnrolledAt.toISOString() : null,
      recoveryCodesRemaining: remaining,
    };
  }

  async setup(userId: string): Promise<Setup2faResponse> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        message: '2FA ya esta activado',
        code: 'already_enabled',
      });
    }
    const secret = this.totp.generateSecret();
    const encrypted = this.crypto.encryptString(secret);
    await this.admin.user.update({
      where: { id: userId },
      data: { twoFactorPendingSecretEncrypted: encrypted },
    });
    return {
      otpauthUri: this.totp.buildOtpAuthUri(secret, user.email),
      secretBase32: secret,
    };
  }

  async verify(
    userId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        message: '2FA ya esta activado',
        code: 'already_enabled',
      });
    }
    if (!user.twoFactorPendingSecretEncrypted) {
      throw new BadRequestException({
        message: 'No hay un setup 2FA en curso',
        code: 'setup_required',
      });
    }
    const secret = this.crypto.decryptString(user.twoFactorPendingSecretEncrypted);
    if (!this.totp.verify(secret, code)) {
      throw new ForbiddenException({
        message: 'Codigo invalido',
        code: 'invalid_code',
      });
    }

    const recoveryCodes = await this.recovery.issueForUser(user.tenantId, userId);
    await this.admin.user.update({
      where: { id: userId },
      data: {
        twoFactorSecretEncrypted: user.twoFactorPendingSecretEncrypted,
        twoFactorPendingSecretEncrypted: null,
        twoFactorEnabled: true,
        twoFactorEnrolledAt: new Date(),
      },
    });
    await this.audit.write({
      tenantId: user.tenantId,
      userId,
      action: 'auth.2fa.enabled',
      entityType: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recoveryCodes };
  }

  async disable(userId: string, input: Disable2faInput, meta: RequestMeta): Promise<void> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecretEncrypted) {
      throw new BadRequestException({
        message: '2FA no esta activado',
        code: 'not_enabled',
      });
    }
    const passwordOk = await argonVerify(user.passwordHash, input.currentPassword);
    if (!passwordOk) {
      throw new ForbiddenException({
        message: 'Contrasena incorrecta',
        code: 'wrong_current_password',
      });
    }
    const ok = await this.verifyChallenge(user.twoFactorSecretEncrypted, userId, input);
    if (!ok) {
      throw new ForbiddenException({
        message: 'Codigo invalido',
        code: 'invalid_code',
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
    await this.recovery.clearForUser(userId);
    await this.audit.write({
      tenantId: user.tenantId,
      userId,
      action: 'auth.2fa.disabled',
      entityType: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  async regenerateRecoveryCodes(
    userId: string,
    input: Regenerate2faRecoveryCodesInput,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecretEncrypted) {
      throw new BadRequestException({
        message: '2FA no esta activado',
        code: 'not_enabled',
      });
    }
    const passwordOk = await argonVerify(user.passwordHash, input.currentPassword);
    if (!passwordOk) {
      throw new ForbiddenException({
        message: 'Contrasena incorrecta',
        code: 'wrong_current_password',
      });
    }
    const secret = this.crypto.decryptString(user.twoFactorSecretEncrypted);
    if (!this.totp.verify(secret, input.code)) {
      throw new ForbiddenException({
        message: 'Codigo invalido',
        code: 'invalid_code',
      });
    }
    const recoveryCodes = await this.recovery.issueForUser(user.tenantId, userId);
    await this.audit.write({
      tenantId: user.tenantId,
      userId,
      action: 'auth.2fa.recovery_codes_regenerated',
      entityType: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recoveryCodes };
  }

  async challenge(
    input: Challenge2faInput,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse>> {
    const { sub, tenantId } = await this.tokens.verify2faPending(input.pendingToken);
    const user = await this.admin.user.findUnique({ where: { id: sub } });
    if (!user || user.tenantId !== tenantId) {
      throw new NotFoundException({
        message: 'Usuario no encontrado',
        code: 'user_not_found',
      });
    }
    if (!user.twoFactorEnabled || !user.twoFactorSecretEncrypted) {
      // El user quito 2FA entre login y challenge: dejamos que vuelva a empezar.
      throw new ForbiddenException({
        message: '2FA no activo',
        code: 'not_enabled',
      });
    }

    const ok = await this.verifyChallenge(user.twoFactorSecretEncrypted, sub, input);
    if (!ok) {
      await this.audit.write({
        tenantId,
        userId: sub,
        action: 'auth.2fa.challenge.failed',
        entityType: 'User',
        entityId: sub,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      throw new ForbiddenException({
        message: 'Codigo invalido',
        code: 'invalid_code',
      });
    }
    await this.audit.write({
      tenantId,
      userId: sub,
      action: 'auth.2fa.challenge.success',
      entityType: 'User',
      entityId: sub,
      changes: { method: input.recoveryCode ? 'recovery_code' : 'totp' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.authService.completeLoginAfter2fa(sub, tenantId, meta);
  }

  // ========================== enrolment forzoso ============================

  /**
   * Inicia el setup 2FA forzoso desde un `enrolmentToken` (publico, sin
   * JwtAuthGuard). El token prueba que el usuario ya supero el password
   * check del login y es owner|manager bajo politica `requireTwoFactorForManagers`.
   *
   * Persiste el secret cifrado en `users.two_factor_pending_secret` y
   * devuelve el URI otpauth para el QR + el secret base32 para entrada
   * manual.
   */
  async enrolRequiredSetup(input: Enrol2faRequiredSetupInput): Promise<Setup2faResponse> {
    const { sub: userId } = await this.tokens.verify2faEnrolmentRequired(input.enrolmentToken);
    const user = await this.admin.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || !user.emailVerifiedAt) {
      throw new NotFoundException({
        message: 'Usuario no encontrado',
        code: 'user_not_found',
      });
    }
    if (user.twoFactorEnabled) {
      // El usuario activo 2FA por otra via entre login y setup; volvemos a
      // empezar para que vaya por el challenge normal.
      throw new BadRequestException({
        message: '2FA ya esta activado',
        code: 'already_enabled',
      });
    }
    const secret = this.totp.generateSecret();
    const encrypted = this.crypto.encryptString(secret);
    await this.admin.user.update({
      where: { id: userId },
      data: { twoFactorPendingSecretEncrypted: encrypted },
    });
    return {
      otpauthUri: this.totp.buildOtpAuthUri(secret, user.email),
      secretBase32: secret,
    };
  }

  /**
   * Verifica el primer codigo TOTP del enrolment forzoso. Si OK: activa
   * 2FA, emite los 10 recovery codes (una sola vez) y, en la misma
   * respuesta, abre la sesion (access JWT + refresh cookie). Devuelve
   * todo lo que el frontend necesita para ir directo al dashboard.
   */
  async enrolRequiredVerify(
    input: Enrol2faRequiredVerifyInput,
    meta: RequestMeta,
  ): Promise<AuthFlowResult<AuthSuccessResponse & { recoveryCodes: string[] }>> {
    const { sub: userId, tenantId } = await this.tokens.verify2faEnrolmentRequired(
      input.enrolmentToken,
    );
    const user = await this.admin.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId || !user.isActive || !user.emailVerifiedAt) {
      throw new NotFoundException({
        message: 'Usuario no encontrado',
        code: 'user_not_found',
      });
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        message: '2FA ya esta activado',
        code: 'already_enabled',
      });
    }
    if (!user.twoFactorPendingSecretEncrypted) {
      throw new BadRequestException({
        message: 'No hay un setup 2FA en curso',
        code: 'setup_required',
      });
    }
    const secret = this.crypto.decryptString(user.twoFactorPendingSecretEncrypted);
    if (!this.totp.verify(secret, input.code)) {
      throw new ForbiddenException({
        message: 'Codigo invalido',
        code: 'invalid_code',
      });
    }

    const recoveryCodes = await this.recovery.issueForUser(tenantId, userId);
    await this.admin.user.update({
      where: { id: userId },
      data: {
        twoFactorSecretEncrypted: user.twoFactorPendingSecretEncrypted,
        twoFactorPendingSecretEncrypted: null,
        twoFactorEnabled: true,
        twoFactorEnrolledAt: new Date(),
      },
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'auth.2fa.enrolment_required.completed',
      entityType: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const session = await this.authService.completeLoginAfterEnrolment(userId, tenantId, meta);
    return {
      body: { ...session.body, recoveryCodes },
      refreshToken: session.refreshToken,
    };
  }

  /**
   * Valida un challenge contra el secret cifrado del user. Si el input trae
   * un recoveryCode, lo consume y registra audit. Si trae un code TOTP, lo
   * verifica.
   */
  private async verifyChallenge(
    encryptedSecret: string,
    userId: string,
    input: Disable2faInput | Challenge2faInput,
  ): Promise<boolean> {
    if (input.recoveryCode) {
      const consumed = await this.recovery.consume(userId, input.recoveryCode);
      if (consumed) {
        const user = await this.admin.user.findUniqueOrThrow({ where: { id: userId } });
        await this.audit.write({
          tenantId: user.tenantId,
          userId,
          action: 'auth.2fa.recovery_code_used',
          entityType: 'User',
          entityId: userId,
        });
      }
      return consumed;
    }
    if (!input.code) return false;
    try {
      const secret = this.crypto.decryptString(encryptedSecret);
      return this.totp.verify(secret, input.code);
    } catch (err) {
      this.logger.error('Error descifrando secret 2FA', err as Error);
      return false;
    }
  }
}
