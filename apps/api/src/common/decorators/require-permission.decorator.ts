import { SetMetadata } from '@nestjs/common';

import type { Permission } from '@storageos/shared';

export const PERMISSION_KEY = 'permissions';

/**
 * Marca un handler (o controller) como accesible solo para usuarios cuyo rol
 * incluya TODOS los permisos indicados. Se evalúa en `PermissionsGuard`.
 *
 *   @RequirePermission('invoices:refund')
 *
 * Es la única capa de autorización fina del panel (la antigua `@Roles` se
 * retiró en RBAC v2). El rol sigue siendo la unidad que se asigna al usuario;
 * los permisos efectivos se derivan de él (o del rol custom del tenant).
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
