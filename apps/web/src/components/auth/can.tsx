'use client';

import type { Permission } from '@storageos/shared';
import type { ReactNode } from 'react';

import { useHasPermission } from '@/lib/auth/hooks';

/**
 * Renderiza `children` solo si el usuario actual tiene el permiso indicado.
 * Gating COSMÉTICO de la UI (ocultar/mostrar acciones); la autorización real
 * la impone el backend (`PermissionsGuard`). Opcionalmente acepta `fallback`
 * para lo que se muestra cuando no hay permiso.
 *
 *   <Can permission="customers:delete">
 *     <Button onClick={handleDelete}>Eliminar</Button>
 *   </Can>
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const allowed = useHasPermission(permission);
  return <>{allowed ? children : fallback}</>;
}
