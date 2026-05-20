import { randomBytes } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import type { Env } from '../../config/env.schema';
import type { UserRole } from '@storageos/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payload firmado dentro del access JWT. */
export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
}

/** Payload + claims estandar al verificar. */
export interface VerifiedAccessToken extends AccessTokenPayload {
  iat: number;
  exp: number;
}

/**
 * Servicio de tokens.
 *
 * Access token (JWT, HS256): firmado con `JWT_ACCESS_SECRET`. Payload minimo
 * `{ sub, tenantId, role }`. TTL configurable (15 min por defecto).
 *
 * Refresh token (opaco): NO es JWT. Tiene la forma
 * `<tenantId>.<sessionId>.<secret>`:
 *   - `tenantId` (UUID v7) permite resolver el contexto RLS antes de buscar
 *     la sesion. No es secreto: el atacante con acceso a la cookie tampoco
 *     gana nada con el id del tenant.
 *   - `sessionId` (UUID v7) identifica la fila en `sessions`.
 *   - `secret` son 32 bytes aleatorios codificados en base64url.
 * Solo el hash argon2id del secret se guarda en BD. La verificacion compara
 * con `argon2.verify`, que es timing-safe.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // -------------------------- access token (JWT) ---------------------------

  async signAccess(payload: AccessTokenPayload): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    const token = await this.jwt.signAsync(
      { tenantId: payload.tenantId, role: payload.role },
      {
        subject: payload.sub,
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn,
      },
    );
    return { token, expiresIn };
  }

  async verifyAccess(token: string): Promise<VerifiedAccessToken> {
    try {
      const payload = await this.jwt.verifyAsync<VerifiedAccessToken>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
      return payload;
    } catch {
      throw new UnauthorizedException('Token de acceso invalido o expirado');
    }
  }

  // ---------------------- refresh token (opaco) ----------------------------

  /**
   * Genera un secret aleatorio fuerte para un nuevo refresh y devuelve su
   * hash argon2id (lo que se guarda en BD).
   */
  async generateRefreshSecret(): Promise<{ secret: string; secretHash: string }> {
    const secret = randomBytes(32).toString('base64url');
    const secretHash = await argonHash(secret);
    return { secret, secretHash };
  }

  /** Construye el string que va a la cookie. */
  formatRefreshToken(tenantId: string, sessionId: string, secret: string): string {
    return `${tenantId}.${sessionId}.${secret}`;
  }

  /**
   * Descompone un refresh token recibido en la cookie. Devuelve `null` si
   * el formato es invalido (en vez de lanzar, para no devolver 500 cuando
   * un cliente manda basura).
   */
  parseRefreshToken(token: string): { tenantId: string; sessionId: string; secret: string } | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [tenantId, sessionId, secret] = parts;
    if (!tenantId || !sessionId || !secret) return null;
    if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(sessionId)) return null;
    return { tenantId, sessionId, secret };
  }

  /** Verifica un secret contra el hash argon2id guardado en `sessions`. */
  async verifyRefreshSecret(secret: string, expectedHash: string): Promise<boolean> {
    try {
      return await argonVerify(expectedHash, secret);
    } catch {
      return false;
    }
  }

  // --------------------- 2FA pending token (corto) -------------------------

  /**
   * Token efimero que se devuelve cuando el login es valido pero el user
   * tiene 2FA activado. NO autentica todavia: solo prueba que la pareja
   * (tenantSlug, email, password) era correcta hace pocos minutos.
   * Firmado con un secret independiente para que no pueda confundirse con
   * un access JWT bajo ningun decoder.
   */
  async sign2faPending(
    sub: string,
    tenantId: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.config.get('JWT_2FA_PENDING_TTL_SECONDS', { infer: true });
    const token = await this.jwt.signAsync(
      { tenantId, purpose: '2fa_pending' },
      {
        subject: sub,
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
        expiresIn,
      },
    );
    return { token, expiresIn };
  }

  async verify2faPending(token: string): Promise<{ sub: string; tenantId: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        tenantId: string;
        purpose: string;
      }>(token, {
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
      });
      if (payload.purpose !== '2fa_pending') {
        throw new Error('purpose');
      }
      return { sub: payload.sub, tenantId: payload.tenantId };
    } catch {
      throw new UnauthorizedException('Token 2FA invalido o expirado');
    }
  }

  // ----------------- 2FA enrolment forzoso (politica tenant) ---------------

  /**
   * Token efimero que se devuelve cuando el login es valido pero el tenant
   * exige 2FA para roles owner/manager y el user no lo tiene activo. NO
   * autentica: solo prueba que la pareja (tenantSlug, email, password) era
   * correcta y permite acceder a los endpoints publicos de enrolment
   * (`/auth/2fa/enrol-required/{setup,verify}`).
   *
   * Reutilizamos `JWT_2FA_PENDING_SECRET` porque el riesgo y vida util son
   * equivalentes a los del `pendingToken`; cambia el `purpose` para que un
   * token de un flujo no pueda abusarse en el otro.
   */
  async sign2faEnrolmentRequired(
    sub: string,
    tenantId: string,
    role: UserRole,
  ): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = ENROLMENT_TOKEN_TTL_SECONDS;
    const token = await this.jwt.signAsync(
      { tenantId, role, purpose: '2fa_enrolment_required' },
      {
        subject: sub,
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
        expiresIn,
      },
    );
    return { token, expiresIn };
  }

  async verify2faEnrolmentRequired(
    token: string,
  ): Promise<{ sub: string; tenantId: string; role: UserRole }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        tenantId: string;
        role: UserRole;
        purpose: string;
      }>(token, {
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
      });
      if (payload.purpose !== '2fa_enrolment_required') {
        throw new Error('purpose');
      }
      return { sub: payload.sub, tenantId: payload.tenantId, role: payload.role };
    } catch {
      throw new UnauthorizedException('Token de enrolment invalido o expirado');
    }
  }
}

/**
 * TTL del enrolmentToken: 15 minutos. Suficiente para escanear el QR,
 * abrir la app de autenticacion y verificar el primer codigo. Si el user
 * tarda mas, simplemente vuelve a hacer login.
 */
const ENROLMENT_TOKEN_TTL_SECONDS = 15 * 60;
