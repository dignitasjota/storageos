/**
 * Rutas de la web (plataforma y webs públicas de los tenants, que sirve la
 * misma aplicación) que no deben salir en Google. Una sola lista para el
 * middleware (`X-Robots-Tag: noindex`), las metaetiquetas de las páginas,
 * `robots.txt` y las reglas de indexación de SEO Avanzado.
 *
 * Regla de oro: lo que lleva `noindex` NO puede estar en `robots.txt`. Si
 * `robots.txt` bloquea una ruta, Google no la rastrea y nunca llega a leer el
 * `noindex`, así que la ruta puede quedarse indexada con el texto del enlace.
 * Lo privado se protege con autenticación; `robots.txt` solo bloquea `/api/`.
 */

/**
 * Páginas sin valor para los buscadores (acceso, enlaces de un solo uso,
 * reserva, pagos, portal, panel…): el middleware les pone «no indexar» en la
 * plataforma y en los dominios propios de los tenants.
 */
export const WEB_NOINDEX_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/forgot-password-sent',
  '/forgot-tenant',
  '/reset-password',
  '/verify-email',
  '/verify-email-sent',
  '/invite',
  '/security',
  '/pay',
  '/review',
  '/unsubscribe',
  '/baja-novedades',
  '/waitlist-confirm',
  '/nps',
  '/sign',
  '/sepa-mandate',
  '/g/',
  '/portal',
  '/book',
  '/reservar',
  '/widget',
  '/impersonation-ended',
  '/dashboard',
  '/settings',
  '/admin',
] as const;

/**
 * Lo que `robots.txt` bloquea. Solo la API: nada que sea una página HTML, para
 * que Google siempre pueda leer el `noindex` de las rutas de arriba.
 */
export const ROBOTS_PRIVATE_PATHS = ['/api/'] as const;

/** ¿La ruta casa con un prefijo de la lista? (`/pay` casa `/pay` y `/pay/…`, no `/payments`). */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/** ¿La ruta debe llevar `noindex`? Lo usa el middleware y las metaetiquetas. */
export function isNoindexPath(pathname: string): boolean {
  return WEB_NOINDEX_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}

/**
 * `robots.txt` de la plataforma. Si la indexación de la plataforma está
 * apagada, se bloquea todo salvo las webs de los tenants (`/s/`).
 */
export function platformRobotsRules(indexable: boolean): {
  userAgent: string;
  allow: string[];
  disallow: string[];
} {
  const privateRules = [...ROBOTS_PRIVATE_PATHS];
  return indexable
    ? { userAgent: '*', allow: ['/', '/s/'], disallow: privateRules }
    : { userAgent: '*', allow: ['/s/'], disallow: ['/', ...privateRules] };
}

/**
 * `robots.txt` del dominio propio de un tenant. Sin rutas bloqueadas: las de
 * reserva, portal, firma y pago llevan `noindex` (ver `WEB_NOINDEX_PREFIXES`).
 */
export function tenantRobotsTxt(sitemapUrl: string): string {
  return ['User-Agent: *', 'Allow: /', '', `Sitemap: ${sitemapUrl}`, ''].join('\n');
}
