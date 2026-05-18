/**
 * @storageos/shared — tipos y utilidades compartidas entre apps.
 *
 * Aquí vivirán: DTOs comunes, enums de dominio, validadores Zod
 * que se consumen desde el backend y el frontend, helpers puros, etc.
 *
 * En Fase 0 sólo expone el marcador de versión para que el paquete
 * sea consumible por los workspaces que ya lo declaran como dependencia.
 */
export const SHARED_PACKAGE_VERSION = '0.0.0' as const;
