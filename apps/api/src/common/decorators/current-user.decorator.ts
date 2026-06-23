import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

import type { Permission, UserRole } from '@storageos/shared';

/**
 * Payload del access token, inyectado en `request.user` por `JwtStrategy`.
 * Coincide con lo que firma `TokensService.signAccess`.
 */
export interface AuthenticatedUser {
  /** UUID del usuario; alias del claim `sub` del JWT. */
  sub: string;
  tenantId: string;
  role: UserRole;
  /** Permisos efectivos del usuario (del JWT). Opcional para tokens antiguos. */
  permissions?: Permission[];
  /**
   * Locales (facility IDs) a los que está restringido el usuario (permisos por
   * local). `null` o ausente = sin restricción (ve todos los locales).
   */
  facilityScope?: string[] | null;
}

/**
 * Decorador de parametro para extraer el user autenticado.
 *
 *   @CurrentUser() user: AuthenticatedUser
 *   @CurrentUser('tenantId') tenantId: string
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) return undefined;
    return field ? request.user[field] : request.user;
  },
);
