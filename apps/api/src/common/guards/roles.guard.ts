import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../decorators/roles.decorator';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { UserRole } from '@storageos/shared';

/**
 * Guard de autorizacion por rol. Se evalua DESPUES del `JwtAuthGuard`
 * (que ya garantiza `request.user`). Si el handler no declara `@Roles()`,
 * permite el acceso a cualquier usuario autenticado.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const role = request.user?.role;
    if (!role) {
      throw new ForbiddenException({
        message: 'No tienes permiso para esta accion',
        code: 'forbidden',
      });
    }
    if (!required.includes(role)) {
      throw new ForbiddenException({
        message: 'Tu rol no tiene permiso para esta accion',
        code: 'insufficient_role',
      });
    }
    return true;
  }
}
