/**
 * Capa de permisos discretos (RBAC de grano fino).
 *
 * Los 4 roles (`owner`/`manager`/`staff`/`readonly`) siguen siendo la unidad
 * que se asigna a cada usuario, pero la AUTORIZACION se expresa en permisos
 * `recurso:accion`. Cada rol mapea a un conjunto de permisos (estatico, en
 * codigo). Esto permite reglas mas finas que las que el rol por si solo podia
 * expresar (p.ej. `invoices:refund` solo para `owner` aunque `manager` pueda
 * emitir) y es la base para roles personalizados por tenant en el futuro.
 *
 * Fuente canonica compartida entre backend (`PermissionsGuard` +
 * `@RequirePermission`) y frontend (`useHasPermission`, gating de UI).
 */

import { UserRoles, type UserRole } from './enums';

export const Permissions = [
  // --- Operación diaria ---
  'customers:read',
  'customers:write',
  'customers:delete',
  'contracts:read',
  'contracts:write', // crear / firmar
  'contracts:manage', // cancelar / finalizar / cambiar precio
  'reservations:read',
  'reservations:write',
  'units:read',
  'units:write',
  'units:manage', // borrar / cambios estructurales
  'facilities:read',
  'facilities:manage',
  'invoices:read',
  'invoices:write', // crear / mark-paid
  'invoices:manage', // emitir / cancelar / rectificar / pdf / recurrente
  'invoices:refund', // devolución (sensible)
  'payments:read',
  'payments:charge',
  'payments:refund', // devolución (sensible)
  'leads:read',
  'leads:write',
  'leads:manage', // borrar (owner/manager)
  'communications:read',
  'communications:send',
  'templates:read',
  'templates:manage',
  'automations:read',
  'automations:manage',
  'tasks:read',
  'tasks:write',
  'tasks:manage', // borrar (owner/manager)
  'incidents:read',
  'incidents:write',
  'incidents:manage', // borrar (owner/manager)
  'products:read',
  'products:write',
  'products:manage',
  'imports:manage', // alta masiva CSV (owner+manager)
  'reviews:read',
  'reviews:write', // solicitar valoraciones (NPS)
  'promotions:read',
  'promotions:manage', // crear/editar códigos promocionales (owner+manager)
  'insurance:read',
  'insurance:manage', // crear/editar planes de seguro (owner+manager)
  'referrals:read',
  'access:read',
  'access:manage',
  'analytics:read',
  'reports:read',
  'reports:run',
  // --- Administración del tenant (típicamente owner) ---
  'users:read',
  'users:manage', // invitar / desactivar / transferir propiedad
  'settings:read',
  'settings:manage', // ajustes del tenant (seguridad, etc.)
  'billing:configure', // series, credenciales AEAT, Holded, Redsys, suscripción
  'integrations:manage', // API keys + webhooks
  'rgpd:manage', // exportación / anonimización
] as const;

export type Permission = (typeof Permissions)[number];

/** Todos los permisos de solo lectura (sufijo `:read`). */
const READ_ONLY: Permission[] = Permissions.filter((p) => p.endsWith(':read'));

/**
 * `staff`: operativa diaria sin acciones destructivas, de gestión avanzada ni
 * administración del tenant.
 */
const STAFF: Permission[] = [
  ...READ_ONLY,
  'customers:write',
  'contracts:write',
  'reservations:write',
  'units:write',
  'invoices:write',
  'payments:charge',
  'leads:write',
  'communications:send',
  'tasks:write',
  'incidents:write',
  'products:write',
  'reports:run',
  'reviews:write',
];

/**
 * `manager`: todo lo operativo + gestión (manage) + reports, EXCEPTO las
 * acciones sensibles de dinero (refunds) y la administración del tenant
 * (settings, billing, usuarios, integraciones, RGPD, borrados).
 */
const MANAGER_EXCLUDED = new Set<Permission>([
  'customers:delete',
  'units:manage',
  'invoices:refund',
  'payments:refund',
  'users:manage',
  'settings:manage',
  'billing:configure',
  'integrations:manage',
  'rgpd:manage',
]);
const MANAGER: Permission[] = Permissions.filter((p) => !MANAGER_EXCLUDED.has(p));

/** `owner`: acceso total. */
const OWNER: Permission[] = [...Permissions];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: OWNER,
  manager: MANAGER,
  staff: STAFF,
  readonly: READ_ONLY,
};

// Sanity: cada rol declarado tiene su lista.
void UserRoles;

/** Permisos efectivos de un rol. */
export function permissionsForRole(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** ¿El rol tiene el permiso indicado? */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/** ¿El rol tiene TODOS los permisos indicados? */
export function roleHasAllPermissions(role: UserRole, permissions: Permission[]): boolean {
  return permissions.every((p) => roleHasPermission(role, p));
}
