import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import type { Env } from '../../config/env.schema';
import type { Request } from 'express';

/**
 * Guard explicito para los controllers `/admin/...`. Comprueba que el JWT
 * Bearer este firmado con `SUPER_ADMIN_JWT_SECRET` y tenga `purpose='superadmin'`.
 *
 * NO se registra como APP_GUARD global: los endpoints admin estan marcados
 * `@Public()` (para saltar `JwtAuthGuard` que valida tokens de tenant) y
 * usan este guard a nivel de controller con `@UseGuards(AdminGuard)`.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedSuperAdmin }>();
    const auth = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(auth);
    if (!match) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Token de super admin requerido',
      });
    }
    const token = match[1] as string;
    let payload: AuthenticatedSuperAdmin;
    try {
      payload = await this.jwt.verifyAsync<AuthenticatedSuperAdmin>(token, {
        secret: this.config.get('SUPER_ADMIN_JWT_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Token de super admin invalido o expirado',
      });
    }
    if (payload.purpose !== 'superadmin') {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Token con purpose invalido',
      });
    }
    req.user = payload;
    return true;
  }
}
