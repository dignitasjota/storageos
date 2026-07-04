import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { REQUIRE_SUPERADMIN_KEY } from './require-superadmin.decorator';

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
 *
 * Ademas aplica `@RequireSuperadmin()`: los endpoints marcados exigen
 * `role === 'superadmin'` (el rol `support` queda limitado a lectura y
 * tareas de soporte no destructivas).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    private readonly adminDb: PrismaAdminService,
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
    // Revocación efectiva: el access JWT dura horas y no era revocable —
    // desactivar un super admin dejaba su token vivo hasta expirar. Un
    // SELECT por PK por request (tráfico admin es mínimo) cierra el hueco.
    const record = await this.adminDb.superAdmin.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    });
    if (!record?.isActive) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Cuenta de super admin desactivada',
      });
    }
    // Separacion de roles: acciones destructivas/de dinero/de seguridad
    // marcadas con @RequireSuperadmin() exigen el rol completo.
    const requiresSuperadmin = this.reflector.getAllAndOverride<boolean>(REQUIRE_SUPERADMIN_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (requiresSuperadmin && payload.role !== 'superadmin') {
      throw new ForbiddenException({
        code: 'insufficient_super_admin_role',
        message: 'Esta acción requiere el rol superadmin',
      });
    }
    req.user = payload;
    return true;
  }
}
