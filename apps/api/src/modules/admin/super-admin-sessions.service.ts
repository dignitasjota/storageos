import { randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { SecurityEventsService } from '../security-events/security-events.service';

import type { Env } from '../../config/env.schema';
import type { SuperAdminSession } from '@storageos/database';
import type { SuperAdminOpenSessionDto } from '@storageos/shared';

/** Margen para dos pestañas o un doble refresco: el token anterior aún vale. */
export const SUPER_ADMIN_REFRESH_GRACE_MS = 30_000;
const SUPER_ADMIN_REFRESH_GRACE_MAX_FORKS = 3;

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
  | 'lost_response'
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
 * `replacedBySessionId` y crea otra nueva. Si se reusa un token ya rotado,
 * revocamos TODAS las sesiones del admin (politica paranoid), salvo dos casos
 * normales que no son un robo: dos pestañas que refrescan a la vez (margen de
 * `SUPER_ADMIN_REFRESH_GRACE_MS`) y una respuesta que no llegó (la sesión que
 * salió de ese token sigue sin usarse). Igual que en `SessionsService`.
 */
@Injectable()
export class SuperAdminSessionsService {
  private readonly logger = new Logger(SuperAdminSessionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly securityEvents: SecurityEventsService,
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

    // Caducada o cerrada a mano sin haber rotado: no hay indicio de robo. Un
    // dispositivo cerrado desde otro intentará renovar y no debe cerrar el resto.
    if (!isRotated && (isExpired || isRevoked)) {
      throw new UnauthorizedException({
        code: 'invalid_refresh',
        message: 'Refresh invalido',
      });
    }

    if (isRotated && !isRevoked && !isExpired) {
      const sameBrowser = (session.userAgent ?? null) === (args.userAgent ?? null);
      const inGrace =
        sameBrowser &&
        now.getTime() - (session.rotatedAt as Date).getTime() <= SUPER_ADMIN_REFRESH_GRACE_MS;
      const recovered = inGrace
        ? await this.forkWithinGrace(session, args)
        : sameBrowser
          ? await this.recoverLostResponse(session, args)
          : null;
      if (recovered) return recovered;
      if (inGrace) {
        // Tope de gracia agotado: se rechaza sin cerrar nada.
        throw new UnauthorizedException({
          code: 'invalid_refresh',
          message: 'Refresh invalido',
        });
      }
    }

    if (isExpired || isRevoked || isRotated) {
      const revokedCount = await this.admin.superAdminSession.updateMany({
        where: { superAdminId: session.superAdminId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'refresh_reuse' },
      });
      await this.invalidateAccessTokens(session.superAdminId);
      const owner = await this.admin.superAdmin.findUnique({
        where: { id: session.superAdminId },
        select: { email: true },
      });
      await this.securityEvents.record({
        eventType: 'refresh_token_reuse',
        emailAttempted: owner?.email ?? null,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
        reason: 'super_admin',
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
          rotatedFromId: session.id,
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

  /** Sesiones abiertas de un super admin; `currentSessionId` marca la de este navegador. */
  async listOpen(
    superAdminId: string,
    currentSessionId?: string | null,
  ): Promise<SuperAdminOpenSessionDto[]> {
    const rows = await this.admin.superAdminSession.findMany({
      where: {
        superAdminId,
        revokedAt: null,
        rotatedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      current: r.id === currentSessionId,
    }));
  }

  /** Cierra una sesión propia. El resto de dispositivos renuevan su token solos. */
  async closeOwn(superAdminId: string, sessionId: string): Promise<void> {
    const closed = await this.admin.superAdminSession.updateMany({
      where: { id: sessionId, superAdminId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
    if (closed.count === 0) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
    }
    await this.invalidateAccessTokens(superAdminId);
  }

  /** Token rotado hace nada en el mismo navegador: sesión hermana, sin cerrar nada. */
  private async forkWithinGrace(
    session: SuperAdminSession,
    args: RotateSuperAdminSessionArgs,
  ): Promise<RotateSuperAdminSessionResult | null> {
    const siblings = await this.admin.superAdminSession.count({
      where: { rotatedFromId: session.id },
    });
    if (siblings >= 1 + SUPER_ADMIN_REFRESH_GRACE_MAX_FORKS) return null;
    return this.createHeir(session, args);
  }

  /**
   * El móvil congela la app a mitad del refresh: el servidor rotó y la cookie
   * nueva no llegó. Si lo que salió de ese token sigue sin usarse, se sustituye.
   * Si alguna heredera ya se usó, es un reuso real.
   */
  private async recoverLostResponse(
    session: SuperAdminSession,
    args: RotateSuperAdminSessionArgs,
  ): Promise<RotateSuperAdminSessionResult | null> {
    const heirs = await this.admin.superAdminSession.findMany({
      where: { rotatedFromId: session.id },
      select: { id: true, rotatedAt: true, revokedAt: true, revokedReason: true },
    });
    if (heirs.length === 0) return null;
    const used = heirs.some(
      (h) => h.rotatedAt !== null || (h.revokedAt !== null && h.revokedReason !== 'lost_response'),
    );
    if (used) return null;
    const live = heirs.filter((h) => h.revokedAt === null).map((h) => h.id);
    // Si otra petición acaba de usar una heredera, no se sustituye.
    const claimed = await this.admin.superAdminSession.updateMany({
      where: { id: { in: live }, revokedAt: null, rotatedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'lost_response' },
    });
    if (claimed.count !== live.length) return null;
    return this.createHeir(session, args);
  }

  private async createHeir(
    session: SuperAdminSession,
    args: RotateSuperAdminSessionArgs,
  ): Promise<RotateSuperAdminSessionResult> {
    const secret = randomBytes(32).toString('base64url');
    const heir = await this.admin.superAdminSession.create({
      data: {
        superAdminId: session.superAdminId,
        refreshTokenHash: await argonHash(secret),
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
        expiresAt: this.computeExpiresAt(),
        rotatedFromId: session.id,
      },
    });
    return {
      session: heir,
      refreshToken: this.formatRefreshToken(heir.id, secret),
      superAdminId: session.superAdminId,
    };
  }

  /**
   * Deja sin valor los access tokens ya emitidos. Los otros dispositivos con
   * sesión viva sacan uno nuevo solos con su cookie de refresh.
   */
  async invalidateAccessTokens(superAdminId: string): Promise<void> {
    await this.admin.superAdmin.update({
      where: { id: superAdminId },
      data: { tokensValidAfter: new Date() },
    });
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
    await this.invalidateAccessTokens(args.superAdminId);
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
