import { SetMetadata } from '@nestjs/common';

import type { Permission } from '@storageos/shared';

export const PERMISSION_KEY = 'permissions';

/**
 * Marca un handler (o controller) como accesible solo para usuarios cuyo rol
 * incluya TODOS los permisos indicados. Se evalúa en `PermissionsGuard`.
 *
 *   @RequirePermission('invoices:refund')
 *
 * Es complementario a `@Roles(...)`: un handler puede usar uno u otro. Para
 * granularidad fina (acciones sensibles) usa permisos; el rol sigue siendo la
 * unidad que se asigna al usuario.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
