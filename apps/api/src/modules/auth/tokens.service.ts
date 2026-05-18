import { randomBytes } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import type { Env } from '../../config/env.schema';
import type { UserRole } from '@storageos/shared';

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
}
