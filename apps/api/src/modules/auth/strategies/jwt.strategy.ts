import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { Env } from '../../../config/env.schema';
import type { Permission, UserRole } from '@storageos/shared';

interface RawAccessPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
  permissions?: Permission[];
  facilityScope?: string[] | null;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /**
   * Passport llama a `validate(payload)` despues de verificar la firma.
   * Lo que devolvamos aqui acaba en `request.user`.
   */
  validate(payload: RawAccessPayload): AuthenticatedUser {
    return {
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      ...(payload.permissions ? { permissions: payload.permissions } : {}),
      facilityScope: payload.facilityScope ?? null,
    };
  }
}
