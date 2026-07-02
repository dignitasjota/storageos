/**
 * Mapeo de rutas para un dominio propio de tenant (white-label). Cuando un
 * request llega por `midominio.com`, el middleware del web resuelve el `slug`
 * del tenant y aplica esta función (pura, testeable) para decidir qué hacer con
 * cada `pathname`:
 *
 *  - `rewrite`: reescritura interna (la URL del usuario NO cambia) hacia la
 *    ruta real de la landing/booking del tenant.
 *  - `redirectToPlatform`: rutas de panel/auth/admin que NO deben servirse bajo
 *    la marca del cliente → 308 al dominio de la plataforma (el middleware
 *    antepone `https://<plataforma>`).
 *  - `next`: pasa tal cual (assets, portal, firma, pago, la propia landing).
 */
export type CustomDomainRoute =
  | { action: 'next' }
  | { action: 'rewrite'; path: string }
  | { action: 'redirectToPlatform'; path: string };

/** Prefijos que se sirven tal cual en un dominio propio (públicos del inquilino). */
const PASS_PREFIXES = ['/portal', '/sign', '/pay', '/review', '/s', '/book', '/_next', '/api'];

/** Rutas de panel/auth/admin: se redirigen al dominio de la plataforma. */
const PLATFORM_PREFIXES = [
  '/login',
  '/register',
  '/dashboard',
  '/settings',
  '/admin',
  '/forgot-password',
  '/forgot-password-sent',
  '/reset-password',
  '/verify-email',
  '/verify-email-sent',
  '/invite',
  '/security',
  '/widget',
];

/** Ruta amigable de reserva en el dominio propio → booking del tenant. */
const BOOK_ALIAS = '/reservar';

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** ¿El path apunta a un archivo (tiene extensión en el último segmento)? */
function looksLikeFile(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  return last.includes('.');
}

export function resolveCustomDomainRoute(pathname: string, slug: string): CustomDomainRoute {
  // Assets y ficheros estáticos (sw.js, manifests, iconos, robots, sitemap…).
  if (pathname.startsWith('/_next') || pathname.startsWith('/api') || looksLikeFile(pathname)) {
    return { action: 'next' };
  }

  // Rutas públicas del inquilino (portal, firma, pago, reseña, landing, booking).
  if (PASS_PREFIXES.some((p) => matchesPrefix(pathname, p))) {
    return { action: 'next' };
  }

  // Panel / auth / admin → al dominio de la plataforma.
  if (PLATFORM_PREFIXES.some((p) => matchesPrefix(pathname, p))) {
    return { action: 'redirectToPlatform', path: pathname };
  }

  // Raíz → landing del tenant.
  if (pathname === '/') {
    return { action: 'rewrite', path: `/s/${slug}` };
  }

  // Alias de reserva → booking del tenant.
  if (matchesPrefix(pathname, BOOK_ALIAS)) {
    return { action: 'rewrite', path: `/book/${slug}` };
  }

  // Un único segmento (p. ej. `/local-norte`) → página del local del tenant.
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1) {
    return { action: 'rewrite', path: `/s/${slug}/${segments[0]}` };
  }

  // Cualquier otra cosa: pasa tal cual (Next resolverá o dará 404).
  return { action: 'next' };
}
