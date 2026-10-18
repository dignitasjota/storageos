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

/**
 * Filtro por local para entidades con `facilityId` propio y OPCIONAL (tareas,
 * incidencias, gastos, mantenimiento, solicitudes…; sin local = de toda la
 * empresa):
 * - con un local elegido: solo ese (`null` si está fuera del alcance → sin resultados);
 * - sin local elegido pero con alcance: sus locales + lo que es de toda la empresa;
 * - sin nada: `{}` (sin filtro).
 */
export function optionalFacilityWhere(
  scope: FacilityScope,
  requestedFacilityId?: string,
):
  | Record<string, never>
  | { facilityId: string }
  | { OR: [{ facilityId: { in: string[] } }, { facilityId: null }] }
  | null {
  if (requestedFacilityId) {
    return isFacilityAllowed(scope, requestedFacilityId)
      ? { facilityId: requestedFacilityId }
      : null;
  }
  if (scope) return { OR: [{ facilityId: { in: scope } }, { facilityId: null }] };
  return {};
}

/**
 * Filtro por local de una factura: su local es el del trastero del contrato, o
 * el que lleva la propia factura (pase nocturno) o su venta de producto. Con
 * alcance y sin local elegido se incluyen las facturas sin contrato (F2, ventas
 * sin local), como hasta ahora. `null` = local fuera del alcance.
 */
export function invoiceFacilityWhere(
  scope: FacilityScope,
  requestedFacilityId?: string,
): Record<string, unknown> | null {
  if (requestedFacilityId) {
    if (!isFacilityAllowed(scope, requestedFacilityId)) return null;
    return {
      OR: [
        { contract: { unit: { facilityId: requestedFacilityId } } },
        { facilityId: requestedFacilityId },
        { productSale: { facilityId: requestedFacilityId } },
      ],
    };
  }
  if (scope) {
    return { OR: [{ contract: { unit: { facilityId: { in: scope } } } }, { contractId: null }] };
  }
  return {};
}
