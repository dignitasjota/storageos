import { SetMetadata } from '@nestjs/common';

import type { UserRole } from '@storageos/shared';

export const ROLES_KEY = 'roles';

/**
 * Marca un handler (o controller) como accesible solo para los roles
 * indicados. Se evalua en `RolesGuard`. Si no se pasa, todos los roles
 * autenticados pueden entrar.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
