import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../database/prisma.service';
import { SecurityEventsService } from '../security-events/security-events.service';

import { TokensService } from './tokens.service';

import type { Env } from '../../config/env.schema';
import type { Session } from '@storageos/database';

export interface CreateSessionArgs {
  tenantId: string;
  userId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface RotateSessionArgs {
  refreshToken: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface RotateResult {
  session: Session;
  refreshToken: string;
  tenantId: string;
  userId: string;
}

export type RevocationReason = 'logout' | 'logout_all' | 'rotated' | 'refresh_reuse';

/**
 * Gestiona el ciclo de vida de las sesiones de refresh.
 *
 *   - `createForLogin`: tras un login exitoso, emite refresh + crea fila.
 *   - `rotate`: valida un refresh recibido y, si todo va bien, marca la
 *     sesion como rotada y emite otra (apuntando a la anterior). Si el
 *     refresh es reusado (sesion revocada o rotada o expirada) revocamos
 *     **todas** las sesiones del usuario -- politica paranoid contra robo
 *     de token.
 *   - `revoke`: logout simple, revoca la sesion actual.
 *   - `revokeAllForUser`: logout global.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<Env, true>,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async createForLogin(
    args: CreateSessionArgs,
  ): Promise<{ session: Session; refreshToken: string }> {
    const { secret, secretHash } = await this.tokens.generateRefreshSecret();
    const expiresAt = this.computeExpiresAt();

    const session = await this.prisma.withTenant(
      (tx) =>
        tx.session.create({
          data: {
            tenantId: args.tenantId,
            userId: args.userId,
            refreshTokenHash: secretHash,
            userAgent: args.userAgent ?? null,
            ipAddress: args.ipAddress ?? null,
            expiresAt,
          },
        }),
      args.tenantId,
    );

    return {
      session,
      refreshToken: this.tokens.formatRefreshToken(args.tenantId, session.id, secret),
    };
  }

  async rotate(args: RotateSessionArgs): Promise<RotateResult> {
    const parsed = this.tokens.parseRefreshToken(args.refreshToken);
    if (!parsed) {
      throw new UnauthorizedException('Refresh invalido');
    }
    const { tenantId, sessionId, secret } = parsed;

    // 1) Lectura: buscar la sesion en su propia transaccion. Si lanzamos
    //    despues, no arrastramos rollback de updates posteriores.
    const session = await this.prisma.withTenant(
      (tx) => tx.session.findUnique({ where: { id: sessionId } }),
      tenantId,
    );
    if (!session || session.tenantId !== tenantId) {
      throw new UnauthorizedException('Refresh invalido');
    }

    // 2) Verificacion del secret (puro, sin BD).
    const secretMatches = await this.tokens.verifyRefreshSecret(secret, session.refreshTokenHash);
    if (!secretMatches) {
      this.logger.warn(`Secret invalido para sesion ${sessionId}`);
      throw new UnauthorizedException('Refresh invalido');
    }

    const now = new Date();
    const isExpired = session.expiresAt.getTime() <= now.getTime();

    if (isExpired) {
      await this.revokeAllAndFlagReuse(session, tenantId, args, 'expired_session');
      throw new UnauthorizedException('Refresh invalido');
    }

    // 3) Rotacion atomica con compare-and-swap: el `updateMany` solo tiene
    //    efecto si la sesion SIGUE `revokedAt: null` en el instante exacto
    //    del UPDATE (no en el instante de la lectura del paso 1). Cierra la
    //    condicion de carrera TOCTOU entre la lectura y la escritura: dos
    //    requests concurrentes con el MISMO refresh token válido hacían cada
    //    una su propia lectura+escritura en transacciones separadas, y un
    //    `update` sin condicion (no `updateMany` filtrado) tenia exito para
    //    AMBAS, generando dos sesiones nuevas a partir de un solo uso del
    //    token sin disparar nunca la deteccion de reuso. El `WHERE
    //    revokedAt IS NULL` hace que Postgres serialice las dos escrituras a
    //    nivel de fila: la que llega segunda ve `revokedAt` ya puesto por la
    //    primera y su `count` sale en 0 -> mismo camino que "ya revocada".
    const { secret: newSecret, secretHash: newHash } = await this.tokens.generateRefreshSecret();
    const newExpiresAt = this.computeExpiresAt();

    const newSession = await this.prisma.withTenant(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'rotated' },
      });
      if (claimed.count === 0) return null;
      return tx.session.create({
        data: {
          tenantId,
          userId: session.userId,
          refreshTokenHash: newHash,
          userAgent: args.userAgent ?? null,
          ipAddress: args.ipAddress ?? null,
          expiresAt: newExpiresAt,
          rotatedFromId: session.id,
        },
      });
    }, tenantId);

    if (!newSession) {
      // Perdió la carrera (o ya estaba revocada por otra vía): mismo
      // tratamiento paranoid que un reuso franco.
      await this.revokeAllAndFlagReuse(session, tenantId, args, 'revoked_session');
      throw new UnauthorizedException('Refresh invalido');
    }

    return {
      session: newSession,
      refreshToken: this.tokens.formatRefreshToken(tenantId, newSession.id, newSecret),
      tenantId,
      userId: session.userId,
    };
  }

  /** Revoca TODAS las sesiones del usuario (política paranoid) + registra el evento de seguridad. */
  private async revokeAllAndFlagReuse(
    session: Session,
    tenantId: string,
    args: RotateSessionArgs,
    reason: 'expired_session' | 'revoked_session',
  ): Promise<void> {
    const now = new Date();
    const revokedCount = await this.prisma.withTenant(
      (tx) =>
        tx.session.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'refresh_reuse' },
        }),
      tenantId,
    );
    this.logger.warn(
      `Reuso de refresh detectado en sesion ${session.id} (user ${session.userId}); revocadas ${revokedCount.count} sesiones`,
    );
    await this.securityEvents.record({
      eventType: 'refresh_token_reuse',
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      reason,
      rawMetadata: {
        tenantId,
        sessionId: session.id,
        userId: session.userId,
        revokedSessionsCount: revokedCount.count,
      },
    });
  }

  async revoke(args: {
    tenantId: string;
    sessionId: string;
    reason?: RevocationReason;
  }): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.session.updateMany({
          where: { id: args.sessionId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: args.reason ?? 'logout',
          },
        }),
      args.tenantId,
    );
  }

  async revokeAllForUser(args: {
    tenantId: string;
    userId: string;
    reason?: RevocationReason;
  }): Promise<number> {
    const result = await this.prisma.withTenant(
      (tx) =>
        tx.session.updateMany({
          where: { userId: args.userId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: args.reason ?? 'logout_all',
          },
        }),
      args.tenantId,
    );
    return result.count;
  }

  private computeExpiresAt(): Date {
    const ttl = this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true });
    return new Date(Date.now() + ttl * 1000);
  }
}
