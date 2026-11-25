/**
 * Rutas de la web (plataforma y webs públicas de los tenants, que sirve la
 * misma aplicación) que no deben salir en Google. Una sola lista para el
 * middleware (`X-Robots-Tag: noindex`), `robots.txt` y las reglas de
 * indexación de SEO Avanzado: si cambia aquí, cambia en los tres sitios.
 */

/**
 * Páginas sin valor para los buscadores (acceso, enlaces de un solo uso,
 * pagos, portal…): el middleware de la web les pone «no indexar».
 */
export const WEB_NOINDEX_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/invite',
  '/security',
  '/pay',
  '/review',
  '/unsubscribe',
  '/waitlist-confirm',
  '/nps',
  '/sign',
  '/sepa-mandate',
  '/g/',
  '/portal',
  '/book',
  '/admin',
] as const;

/** Lo que `robots.txt` bloquea siempre (panel, portal, widget y API). */
export const ROBOTS_PRIVATE_PATHS = [
  '/dashboard',
  '/settings',
  '/admin',
  '/portal',
  '/api/',
  '/widget/',
  '/book/',
] as const;

/** ¿La ruta casa con un prefijo de la lista? (`/pay` casa `/pay` y `/pay/…`, no `/payments`). */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}
