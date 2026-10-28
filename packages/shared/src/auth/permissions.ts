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
  'collections:read',
  'collections:manage', // gestionar expedientes de impago (owner+manager)
  'expenses:read',
  'expenses:manage', // registrar/editar gastos (owner+manager, contabilidad)
  'marketing:read',
  'marketing:manage', // canales/campañas de captación (owner+manager)
  'referrals:read',
  'access:read',
  'access:manage',
  'analytics:read',
  'reports:read',
  'reports:run',
  'ai:use', // asistente IA para staff (owner/manager/staff)
  'notifications:read', // bandeja de notificaciones in-app del tenant (todos los roles)
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
  'ai:use',
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

/** Nombre de cada recurso para la pantalla de roles. */
export const PERMISSION_RESOURCE_LABELS: Record<string, string> = {
  customers: 'Inquilinos',
  contracts: 'Contratos',
  reservations: 'Reservas',
  units: 'Trasteros',
  facilities: 'Locales',
  invoices: 'Facturas',
  payments: 'Cobros',
  leads: 'Contactos',
  communications: 'Comunicaciones',
  templates: 'Plantillas',
  automations: 'Automatizaciones',
  tasks: 'Tareas',
  incidents: 'Incidencias',
  products: 'Productos',
  imports: 'Importaciones',
  reviews: 'Valoraciones',
  promotions: 'Promociones y cupones',
  insurance: 'Seguros',
  collections: 'Impagos',
  expenses: 'Gastos',
  marketing: 'Marketing',
  referrals: 'Referidos',
  access: 'Accesos',
  analytics: 'Analítica',
  reports: 'Informes',
  ai: 'Asistente IA',
  notifications: 'Notificaciones',
  users: 'Usuarios',
  settings: 'Configuración',
  billing: 'Facturación y cobros (ajustes)',
  integrations: 'Integraciones',
  rgpd: 'Protección de datos',
};

/** Qué permite cada acción. */
export const PERMISSION_ACTION_LABELS: Record<string, string> = {
  read: 'Ver',
  write: 'Crear y editar',
  manage: 'Gestionar (borrar y configurar)',
  delete: 'Borrar',
  refund: 'Devolver dinero',
  charge: 'Cobrar',
  send: 'Enviar',
  run: 'Generar',
  use: 'Usar',
  configure: 'Configurar',
};

/** «Facturas · Ver» para un permiso como `invoices:read`. */
export function permissionLabel(p: string): string {
  const [resource = p, action = ''] = p.split(':');
  return `${PERMISSION_RESOURCE_LABELS[resource] ?? resource} · ${PERMISSION_ACTION_LABELS[action] ?? action}`;
}

/** Plantillas para crear un rol a medida con un clic (se pueden ajustar después). */
export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  baseRole: 'staff' | 'readonly';
  permissions: Permission[];
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'site_manager',
    name: 'Encargado de local',
    description: 'Atiende el mostrador: inquilinos, contratos, cobros, tareas e incidencias.',
    baseRole: 'staff',
    permissions: [
      'customers:read',
      'customers:write',
      'contracts:read',
      'contracts:write',
      'reservations:read',
      'reservations:write',
      'units:read',
      'units:write',
      'facilities:read',
      'invoices:read',
      'invoices:write',
      'payments:read',
      'payments:charge',
      'leads:read',
      'leads:write',
      'communications:read',
      'communications:send',
      'templates:read',
      'tasks:read',
      'tasks:write',
      'incidents:read',
      'incidents:write',
      'products:read',
      'products:write',
      'reviews:read',
      'reviews:write',
      'promotions:read',
      'insurance:read',
      'collections:read',
      'access:read',
      'reports:read',
      'ai:use',
      'notifications:read',
    ],
  },
  {
    key: 'accountant',
    name: 'Contable',
    description: 'Facturas, cobros, gastos e informes; ve inquilinos y contratos sin cambiarlos.',
    baseRole: 'staff',
    permissions: [
      'customers:read',
      'contracts:read',
      'invoices:read',
      'invoices:write',
      'invoices:manage',
      'payments:read',
      'payments:charge',
      'expenses:read',
      'expenses:manage',
      'collections:read',
      'reports:read',
      'reports:run',
      'analytics:read',
      'notifications:read',
    ],
  },
  {
    key: 'sales',
    name: 'Comercial',
    description: 'Contactos, reservas y contratos nuevos; campañas y promociones.',
    baseRole: 'staff',
    permissions: [
      'leads:read',
      'leads:write',
      'leads:manage',
      'customers:read',
      'customers:write',
      'contracts:read',
      'contracts:write',
      'reservations:read',
      'reservations:write',
      'units:read',
      'facilities:read',
      'communications:read',
      'communications:send',
      'templates:read',
      'promotions:read',
      'referrals:read',
      'reviews:read',
      'reviews:write',
      'marketing:read',
      'analytics:read',
      'ai:use',
      'notifications:read',
    ],
  },
];

/**
 * Resumen legible de un conjunto de permisos: qué áreas ve y en cuáles puede
 * hacer cambios (cualquier permiso distinto de «:read»).
 */
export function summarizePermissions(perms: readonly string[]): {
  sees: string[];
  changes: string[];
} {
  const sees = new Set<string>();
  const changes = new Set<string>();
  for (const p of perms) {
    const [resource = '', action = ''] = p.split(':');
    const label = PERMISSION_RESOURCE_LABELS[resource] ?? resource;
    sees.add(label);
    if (action !== 'read') changes.add(label);
  }
  return { sees: [...sees], changes: [...changes] };
}
