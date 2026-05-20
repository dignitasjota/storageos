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
    const isRevoked = session.revokedAt !== null;

    if (isExpired || isRevoked) {
      // 3a) Paranoid revoke-all en una transaccion DEDICADA: si la pusieramos
      //     dentro de la transaccion que luego lanza, Prisma haria rollback
      //     y se perderia la revocacion.
      const revokedCount = await this.prisma.withTenant(
        (tx) =>
          tx.session.updateMany({
            where: { userId: session.userId, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'refresh_reuse' },
          }),
        tenantId,
      );
      this.logger.warn(
        `Reuso de refresh detectado en sesion ${sessionId} (user ${session.userId}); revocadas ${revokedCount.count} sesiones`,
      );
      await this.securityEvents.record({
        eventType: 'refresh_token_reuse',
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        reason: isExpired ? 'expired_session' : 'revoked_session',
        rawMetadata: {
          tenantId,
          sessionId,
          userId: session.userId,
          revokedSessionsCount: revokedCount.count,
        },
      });
      throw new UnauthorizedException('Refresh invalido');
    }

    // 3b) Rotacion atomica: marca la actual como rotated y crea la nueva
    //     con `rotatedFromId`. Una sola transaccion para ambos pasos.
    const { secret: newSecret, secretHash: newHash } = await this.tokens.generateRefreshSecret();
    const newExpiresAt = this.computeExpiresAt();

    const newSession = await this.prisma.withTenant(async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: now, revokedReason: 'rotated' },
      });
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

    return {
      session: newSession,
      refreshToken: this.tokens.formatRefreshToken(tenantId, newSession.id, newSecret),
      tenantId,
      userId: session.userId,
    };
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
