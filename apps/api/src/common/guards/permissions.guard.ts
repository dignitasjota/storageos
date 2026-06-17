import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasAllPermissions } from '@storageos/shared';

import { PERMISSION_KEY } from '../decorators/require-permission.decorator';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { Permission } from '@storageos/shared';

/**
 * Guard de autorización por permiso fino. Se evalúa DESPUÉS del `JwtAuthGuard`
 * (que garantiza `request.user`) y junto al `RolesGuard`. Si el handler no
 * declara `@RequirePermission()`, deja pasar (la autorización la decide
 * `@Roles` o el endpoint es abierto a cualquier autenticado).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSION_KEY, [
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
    if (!roleHasAllPermissions(role, required)) {
      throw new ForbiddenException({
        message: 'Tu rol no tiene permiso para esta accion',
        code: 'insufficient_permission',
        details: { requiredPermissions: required },
      });
    }
    return true;
  }
}
