import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

import type { SuperAdminRoleValue } from '@storageos/shared';

/**
 * Payload del JWT de super admin (purpose='superadmin'), inyectado en
 * `request.user` por `AdminGuard`. NO comparte secret con el JWT de tenant
 * users: se firma con `SUPER_ADMIN_JWT_SECRET` y se verifica explicitamente
 * en `AdminGuard`.
 */
export interface AuthenticatedSuperAdmin {
  /** UUID del super admin; alias del claim `sub`. */
  sub: string;
  email: string;
  role: SuperAdminRoleValue;
  purpose: 'superadmin';
  iat?: number;
  exp?: number;
}

/**
 * Decorador de parametro para extraer el super admin autenticado.
 *
 *   @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin
 *   @CurrentSuperAdmin('sub') adminId: string
 */
export const CurrentSuperAdmin = createParamDecorator(
  (field: keyof AuthenticatedSuperAdmin | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedSuperAdmin }>();
    if (!request.user) return undefined;
    return field ? request.user[field] : request.user;
  },
);
