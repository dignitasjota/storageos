import { randomBytes } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { SuperAdminSession } from '@storageos/database';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateSuperAdminSessionArgs {
  superAdminId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface RotateSuperAdminSessionArgs {
  refreshToken: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface RotateSuperAdminSessionResult {
  session: SuperAdminSession;
  refreshToken: string;
  superAdminId: string;
}

export type SuperAdminRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'rotated'
  | 'refresh_reuse'
  | 'password_changed'
  | 'two_factor_disabled';

/**
 * Gestion del ciclo de vida de las sesiones de refresh del super admin.
 *
 * Token opaco con shape `<sessionId>.<secret>` (sin `tenantId`, a diferencia
 * del refresh de tenant users porque los super admins son globales).
 * Persistimos solo el hash argon2id del secret en BD.
 *
 * Rotacion estricta: cada refresh marca la sesion actual como `rotatedAt` +
 * `replacedBySessionId` y crea otra nueva. Si se reusa un token ya rotado o
 * expirado, revocamos TODAS las sesiones del admin (politica paranoid).
 */
@Injectable()
export class SuperAdminSessionsService {
  private readonly logger = new Logger(SuperAdminSessionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async createSession(
    args: CreateSuperAdminSessionArgs,
  ): Promise<{ session: SuperAdminSession; refreshToken: string }> {
    const secret = randomBytes(32).toString('base64url');
    const refreshTokenHash = await argonHash(secret);
    const expiresAt = this.computeExpiresAt();

    const session = await this.admin.superAdminSession.create({
      data: {
        superAdminId: args.superAdminId,
        refreshTokenHash,
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
        expiresAt,
      },
    });

    return {
      session,
      refreshToken: this.formatRefreshToken(session.id, secret),
    };
  }

  async rotateSession(args: RotateSuperAdminSessionArgs): Promise<RotateSuperAdminSessionResult> {
    const parsed = this.parseRefreshToken(args.refreshToken);
    if (!parsed) {
      throw new UnauthorizedException({
        code: 'invalid_refresh',
        message: 'Refresh invalido',
      });
    }
    const { sessionId, secret } = parsed;

    const session = await this.admin.superAdminSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new UnauthorizedException({
        code: 'invalid_refresh',
        message: 'Refresh invalido',
      });
    }

    let secretMatches = false;
    try {
      secretMatches = await argonVerify(session.refreshTokenHash, secret);
    } catch {
      secretMatches = false;
    }
    if (!secretMatches) {
      this.logger.warn(`Secret invalido para super_admin_sessions.${sessionId}`);
      throw new UnauthorizedException({
        code: 'invalid_refresh',
        message: 'Refresh invalido',
      });
    }

    const now = new Date();
    const isExpired = session.expiresAt.getTime() <= now.getTime();
    const isRevoked = session.revokedAt !== null;
    const isRotated = session.rotatedAt !== null;

    if (isExpired || isRevoked || isRotated) {
      const revokedCount = await this.admin.superAdminSession.updateMany({
        where: { superAdminId: session.superAdminId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'refresh_reuse' },
      });
      this.logger.warn(
        `Reuso de refresh detectado en super_admin_sessions.${sessionId} (admin ${session.superAdminId}); revocadas ${revokedCount.count} sesiones`,
      );
      throw new UnauthorizedException({
        code: 'invalid_refresh',
        message: 'Refresh invalido',
      });
    }

    const newSecret = randomBytes(32).toString('base64url');
    const newHash = await argonHash(newSecret);
    const newExpiresAt = this.computeExpiresAt();

    // Rotacion atomica via $transaction: marca la actual rotated + crea la
    // nueva apuntando a ella con `replacedBySessionId`.
    const newSession = await this.admin.$transaction(async (tx) => {
      const created = await tx.superAdminSession.create({
        data: {
          superAdminId: session.superAdminId,
          refreshTokenHash: newHash,
          userAgent: args.userAgent ?? null,
          ipAddress: args.ipAddress ?? null,
          expiresAt: newExpiresAt,
        },
      });
      await tx.superAdminSession.update({
        where: { id: session.id },
        data: {
          rotatedAt: now,
          replacedBySessionId: created.id,
        },
      });
      return created;
    });

    return {
      session: newSession,
      refreshToken: this.formatRefreshToken(newSession.id, newSecret),
      superAdminId: session.superAdminId,
    };
  }

  async revokeSession(args: {
    sessionId: string;
    reason?: SuperAdminRevocationReason;
  }): Promise<void> {
    await this.admin.superAdminSession.updateMany({
      where: { id: args.sessionId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: args.reason ?? 'logout',
      },
    });
  }

  async revokeAll(args: {
    superAdminId: string;
    reason?: SuperAdminRevocationReason;
  }): Promise<number> {
    const result = await this.admin.superAdminSession.updateMany({
      where: { superAdminId: args.superAdminId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: args.reason ?? 'logout_all',
      },
    });
    return result.count;
  }

  // ----------------------------- helpers -----------------------------------

  formatRefreshToken(sessionId: string, secret: string): string {
    return `${sessionId}.${secret}`;
  }

  parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [sessionId, secret] = parts;
    if (!sessionId || !secret) return null;
    if (!UUID_REGEX.test(sessionId)) return null;
    return { sessionId, secret };
  }

  private computeExpiresAt(): Date {
    const ttl = this.config.get('SUPER_ADMIN_REFRESH_TTL_SECONDS', { infer: true });
    return new Date(Date.now() + ttl * 1000);
  }

  /** TTL en segundos para construir maxAge de la cookie en el controller. */
  getRefreshTtlSeconds(): number {
    return this.config.get('SUPER_ADMIN_REFRESH_TTL_SECONDS', { infer: true });
  }
}
