import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { Env } from '../../../config/env.schema';
import type { Permission, UserRole } from '@storageos/shared';

interface RawAccessPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
  permissions?: Permission[];
  facilityScope?: string[] | null;
  purpose?: string;
  impersonationId?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<Env, true>,
    private readonly admin: PrismaAdminService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /**
   * Passport llama a `validate(payload)` despues de verificar la firma.
   * Lo que devolvamos aqui acaba en `request.user`.
   *
   * Un JWT de impersonación (`purpose: 'impersonation'`) es, por diseño, un
   * access token normal — `ImpersonationService` lo firma así a propósito
   * para que el resto de guards lo acepten sin tocar nada. Pero eso significa
   * que, una vez emitido, es indistinguible de cualquier otro y vive hasta su
   * `exp` SIN que nada pueda cortarlo antes (el registro `ImpersonationLog`
   * es solo auditoría, no se consulta). Aquí, y SOLO para este tipo de token
   * (el resto de requests no paga el round-trip extra), se comprueba en cada
   * petición si la sesión fue revocada — así el "kill switch" del panel
   * admin (`AdminImpersonationAuditService.revoke`) invalida el token ya
   * emitido de verdad, no solo el registro.
   */
  async validate(payload: RawAccessPayload): Promise<AuthenticatedUser> {
    if (payload.purpose === 'impersonation' && payload.impersonationId) {
      const log = await this.admin.impersonationLog.findUnique({
        where: { id: payload.impersonationId },
        select: { revokedAt: true },
      });
      if (!log || log.revokedAt) {
        throw new UnauthorizedException({
          code: 'impersonation_revoked',
          message: 'La sesión de impersonación fue revocada',
        });
      }
    }
    return {
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      ...(payload.permissions ? { permissions: payload.permissions } : {}),
      facilityScope: payload.facilityScope ?? null,
    };
  }
}
