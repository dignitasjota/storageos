import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  APP_LOCK_IDLE_MINUTES,
  APP_LOCK_MAX_PIN_ATTEMPTS,
  type AppLockStatusDto,
  type AppLockUnlockResultDto,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';

/** Reto de una llave de acceso: vale 5 minutos y un solo uso. */
const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Bloqueo de la app del panel instalada en el móvil. La sesión dura 90 días;
 * tras `APP_LOCK_IDLE_MINUTES` sin uso la web pide Face ID / huella (llave de
 * acceso WebAuthn, verificada aquí) o el PIN de respaldo. Cinco PIN mal
 * seguidos cierran todas las sesiones del usuario (vuelve a la contraseña).
 */
@Injectable()
export class AppLockService {
  private readonly rpId: string;
  private readonly origin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    const web = new URL(config.get('WEB_BASE_URL', { infer: true }));
    this.rpId = web.hostname;
    this.origin = web.origin;
  }

  async status(tenantId: string, userId: string): Promise<AppLockStatusDto> {
    const [user, passkeys] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.user.findUniqueOrThrow({ where: { id: userId }, select: { appPinHash: true } }),
          tx.userPasskey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        ]),
      tenantId,
    );
    return {
      pinSet: user.appPinHash !== null,
      passkeys: passkeys.map((p) => ({
        id: p.id,
        label: p.label,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      })),
      idleMinutes: APP_LOCK_IDLE_MINUTES,
    };
  }

  async setPin(tenantId: string, userId: string, pin: string, meta: RequestMeta): Promise<void> {
    const pinHash = await argonHash(pin);
    await this.prisma.withTenant(
      (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { appPinHash: pinHash, appPinFailedAttempts: 0 },
        }),
      tenantId,
    );
    await this.trace(tenantId, userId, 'app_lock.pin_set', meta);
  }

  async removePin(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { appPinHash: null, appPinFailedAttempts: 0 },
        }),
      tenantId,
    );
    await this.trace(tenantId, userId, 'app_lock.pin_removed', meta);
  }

  async registrationOptions(
    tenantId: string,
    userId: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const { user, passkeys } = await this.prisma.withTenant(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, fullName: true },
      });
      const p = await tx.userPasskey.findMany({
        where: { userId },
        select: { credentialId: true, transports: true },
      });
      return { user: u, passkeys: p };
    }, tenantId);
    const options = await generateRegistrationOptions({
      rpName: 'TrasterOS',
      rpID: this.rpId,
      userName: user.email,
      userDisplayName: user.fullName,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        // Face ID / huella del propio móvil.
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await this.saveChallenge(tenantId, userId, options.challenge);
    return options;
  }

  async register(
    tenantId: string,
    userId: string,
    response: RegistrationResponseJSON,
    label: string,
    meta: RequestMeta,
  ): Promise<void> {
    const expectedChallenge = await this.takeChallenge(tenantId, userId);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new BadRequestException({
        code: 'passkey_invalid',
        message: 'No se ha podido activar Face ID / huella. Inténtalo otra vez.',
      });
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException({
        code: 'passkey_invalid',
        message: 'No se ha podido activar Face ID / huella. Inténtalo otra vez.',
      });
    }
    const { credential } = verification.registrationInfo;
    await this.prisma.withTenant(
      (tx) =>
        tx.userPasskey.create({
          data: {
            tenantId,
            userId,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: BigInt(credential.counter),
            transports: credential.transports ?? [],
            label,
          },
        }),
      tenantId,
    );
    await this.trace(tenantId, userId, 'app_lock.passkey_added', meta);
  }

  async removePasskey(
    tenantId: string,
    userId: string,
    passkeyId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) => tx.userPasskey.deleteMany({ where: { id: passkeyId, userId } }),
      tenantId,
    );
    if (count === 0) {
      throw new NotFoundException({ code: 'passkey_not_found', message: 'No encontrada' });
    }
    await this.trace(tenantId, userId, 'app_lock.passkey_removed', meta);
  }

  async unlockOptions(
    tenantId: string,
    userId: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const passkeys = await this.prisma.withTenant(
      (tx) =>
        tx.userPasskey.findMany({
          where: { userId },
          select: { credentialId: true, transports: true },
        }),
      tenantId,
    );
    if (passkeys.length === 0) {
      throw new BadRequestException({
        code: 'no_passkeys',
        message: 'No tienes Face ID / huella activado en la app',
      });
    }
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: 'required',
      allowCredentials: passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
    });
    await this.saveChallenge(tenantId, userId, options.challenge);
    return options;
  }

  async unlockWithPasskey(
    tenantId: string,
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<AppLockUnlockResultDto> {
    const expectedChallenge = await this.takeChallenge(tenantId, userId);
    const passkey = await this.prisma.withTenant(
      (tx) => tx.userPasskey.findFirst({ where: { userId, credentialId: response.id } }),
      tenantId,
    );
    if (!passkey) {
      throw new UnauthorizedException({
        code: 'passkey_unknown',
        message: 'Esta llave no está activada para tu usuario',
      });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      verification = null;
    }
    if (!verification?.verified) {
      throw new UnauthorizedException({
        code: 'passkey_failed',
        message: 'No se ha podido comprobar Face ID / huella',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.userPasskey.update({
        where: { id: passkey.id },
        data: {
          counter: BigInt(verification.authenticationInfo.newCounter),
          lastUsedAt: new Date(),
        },
      });
      await tx.user.update({ where: { id: userId }, data: { appPinFailedAttempts: 0 } });
    }, tenantId);
    return { unlocked: true };
  }

  async unlockWithPin(
    tenantId: string,
    userId: string,
    pin: string,
    meta: RequestMeta,
  ): Promise<AppLockUnlockResultDto> {
    const user = await this.prisma.withTenant(
      (tx) =>
        tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { appPinHash: true, appPinFailedAttempts: true },
        }),
      tenantId,
    );
    if (!user.appPinHash) {
      throw new BadRequestException({ code: 'no_pin', message: 'No tienes un PIN para la app' });
    }
    if (await argonVerify(user.appPinHash, pin)) {
      if (user.appPinFailedAttempts > 0) {
        await this.prisma.withTenant(
          (tx) => tx.user.update({ where: { id: userId }, data: { appPinFailedAttempts: 0 } }),
          tenantId,
        );
      }
      return { unlocked: true };
    }
    // Incremento atómico: dos intentos a la vez no se pisan el contador.
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { appPinFailedAttempts: { increment: 1 } },
          select: { appPinFailedAttempts: true },
        }),
      tenantId,
    );
    if (updated.appPinFailedAttempts >= APP_LOCK_MAX_PIN_ATTEMPTS) {
      await this.sessions.revokeAllForUser({ tenantId, userId, reason: 'logout_all' });
      await this.prisma.withTenant(
        (tx) => tx.user.update({ where: { id: userId }, data: { appPinFailedAttempts: 0 } }),
        tenantId,
      );
      await this.trace(tenantId, userId, 'app_lock.pin_exhausted', meta);
      throw new UnauthorizedException({
        code: 'app_lock_exhausted',
        message: 'Demasiados intentos. Vuelve a entrar con tu contraseña.',
      });
    }
    const left = APP_LOCK_MAX_PIN_ATTEMPTS - updated.appPinFailedAttempts;
    throw new BadRequestException({
      code: 'wrong_pin',
      message: `PIN incorrecto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`,
      details: { attemptsLeft: left },
    });
  }

  private async saveChallenge(tenantId: string, userId: string, challenge: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.user.update({
          where: { id: userId },
          data: {
            webauthnChallenge: challenge,
            webauthnChallengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          },
        }),
      tenantId,
    );
  }

  /** Lee y borra el reto pendiente (un solo uso). */
  private async takeChallenge(tenantId: string, userId: string): Promise<string> {
    const user = await this.prisma.withTenant(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { webauthnChallenge: true, webauthnChallengeExpiresAt: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: { webauthnChallenge: null, webauthnChallengeExpiresAt: null },
      });
      return u;
    }, tenantId);
    if (
      !user.webauthnChallenge ||
      !user.webauthnChallengeExpiresAt ||
      user.webauthnChallengeExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException({
        code: 'passkey_challenge_expired',
        message: 'Ha caducado. Vuelve a intentarlo.',
      });
    }
    return user.webauthnChallenge;
  }

  private async trace(
    tenantId: string,
    userId: string,
    action: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId,
      action,
      entityType: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }
}
