import { ForbiddenException } from '@nestjs/common';

/**
 * Permisos por local. `null`/`undefined` = sin restricción (ve todos los
 * locales). Un array = el usuario solo ve/gestiona esos `facilityId`.
 */
export type FacilityScope = string[] | null | undefined;

/** ¿El usuario puede ver/gestionar este local? (sin scope = sí). */
export function isFacilityAllowed(scope: FacilityScope, facilityId: string): boolean {
  return !scope || scope.includes(facilityId);
}

/** Lanza 403 si el local no está en el scope del usuario. */
export function assertFacilityAllowed(scope: FacilityScope, facilityId: string): void {
  if (!isFacilityAllowed(scope, facilityId)) {
    throw new ForbiddenException({
      code: 'facility_not_in_scope',
      message: 'No tienes acceso a ese local',
    });
  }
}

/**
 * Resuelve la lista de facilityId a filtrar combinando el scope del usuario con
 * un filtro explícito por local. Devuelve `undefined` (sin filtro) si no hay
 * scope ni filtro; `null` si el filtro pedido está fuera del scope (→ sin
 * resultados); o el array de IDs a filtrar.
 */
export function resolveFacilityFilter(
  scope: FacilityScope,
  requestedFacilityId?: string,
): string[] | null | undefined {
  if (requestedFacilityId) {
    if (!isFacilityAllowed(scope, requestedFacilityId)) return null;
    return [requestedFacilityId];
  }
  return scope ?? undefined;
}
