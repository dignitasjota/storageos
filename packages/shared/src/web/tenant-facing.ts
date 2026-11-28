import { matchesPathPrefix } from './noindex';

/**
 * Rutas de la plataforma que son de cara al cliente de un negocio (reserva,
 * firma, pago, portal, widget…). Su página 404 no es la de TrasterOS: sale la
 * neutral, igual que en los dominios propios de los tenants.
 */
export const TENANT_FACING_PREFIXES = [
  '/s',
  '/book',
  '/reservar',
  '/sign',
  '/pay',
  '/review',
  '/portal',
  '/widget',
  '/g',
  '/unsubscribe',
  '/nps',
  '/waitlist-confirm',
  '/baja-novedades',
  '/sepa-mandate',
] as const;

/** ¿La ruta es de cara al cliente de un negocio? (`/s/x` sí, `/sign-up` no). */
export function isTenantFacingPath(pathname: string): boolean {
  return TENANT_FACING_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}
