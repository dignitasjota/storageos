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
  /** Rol personalizado con el que se emitió (tokens anteriores no lo llevan). */
  trid?: string | null;
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
    let impersonation: AuthenticatedUser['impersonation'];
    if (payload.purpose === 'impersonation' && payload.impersonationId) {
      const log = await this.admin.impersonationLog.findUnique({
        where: { id: payload.impersonationId },
        select: { revokedAt: true, readOnly: true, expiresAt: true },
      });
      if (!log || log.revokedAt) {
        throw new UnauthorizedException({
          code: 'impersonation_revoked',
          message: 'La sesión de impersonación fue revocada',
        });
      }
      impersonation = {
        id: payload.impersonationId,
        readOnly: log.readOnly,
        expiresAt: log.expiresAt,
      };
    }
    // El token dura 15 minutos: sin esta comprobación, un usuario desactivado o
    // con menos permisos seguía usando el que tenía hasta que caducara.
    const user = await this.admin.user.findUnique({
      where: { id: payload.sub },
      select: { tenantId: true, isActive: true, role: true, tenantRoleId: true },
    });
    if (!user || !user.isActive || user.tenantId !== payload.tenantId) {
      throw new UnauthorizedException({
        code: 'account_unavailable',
        message: 'La cuenta ya no está disponible',
      });
    }
    // Rol cambiado: se rechaza y la web pide un token nuevo con los permisos
    // actuales. La sesión de soporte lleva su propio rol (solo lectura).
    if (
      !impersonation &&
      (user.role !== payload.role ||
        (payload.trid !== undefined && (payload.trid ?? null) !== user.tenantRoleId))
    ) {
      throw new UnauthorizedException({
        code: 'session_outdated',
        message: 'Tus permisos han cambiado. Vuelve a cargar la página.',
      });
    }
    return {
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      ...(payload.permissions ? { permissions: payload.permissions } : {}),
      facilityScope: payload.facilityScope ?? null,
      ...(impersonation ? { impersonation } : {}),
    };
  }
}
