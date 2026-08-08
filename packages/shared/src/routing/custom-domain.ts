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
 *
 * `opts.externalSite`: el tenant sirve su web PROPIA (alojada fuera de la
 * plataforma) vía proxy inverso en `/tenant-site/<slug>/<path>` — ver
 * `apps/web/src/app/(public)/tenant-site`. En ese modo, cualquier ruta no
 * reservada (incluidos ficheros y rutas anidadas) se reescribe hacia ahí en
 * vez de hacia la landing/facility de nuestras plantillas.
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

export function resolveCustomDomainRoute(
  pathname: string,
  slug: string,
  opts?: { externalSite?: boolean },
): CustomDomainRoute {
  const externalSite = opts?.externalSite ?? false;

  // Internals de Next (chunks, HMR…) siempre pasan tal cual.
  if (pathname.startsWith('/_next') || pathname.startsWith('/api')) {
    return { action: 'next' };
  }

  // Ficheros estáticos de la PLATAFORMA (sw.js, manifests, iconos, robots,
  // sitemap…) pasan tal cual — salvo en modo `externalSite`, donde cualquier
  // fichero (style.css, script.js, img/logo.png…) pertenece a la web propia
  // del tenant, no a la nuestra, y debe proxearse (más abajo).
  if (!externalSite && looksLikeFile(pathname)) {
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

  // Alias de reserva → booking del tenant. Es una función de la PLATAFORMA
  // (crea un contrato), no de la web propia del tenant → aplica también con
  // `externalSite` (antes del proxy catch-all, para no perderlo ahí).
  if (matchesPrefix(pathname, BOOK_ALIAS)) {
    return { action: 'rewrite', path: `/book/${slug}` };
  }

  if (externalSite) {
    // Cualquier otra ruta (raíz, ficheros, rutas anidadas) → proxy hacia la
    // web externa del tenant.
    const rest = pathname === '/' ? '' : pathname;
    return { action: 'rewrite', path: `/tenant-site/${slug}${rest}` };
  }

  // Raíz → landing del tenant.
  if (pathname === '/') {
    return { action: 'rewrite', path: `/s/${slug}` };
  }

  // Un único segmento (p. ej. `/local-norte`) → página del local del tenant.
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1) {
    return { action: 'rewrite', path: `/s/${slug}/${segments[0]}` };
  }

  // Cualquier otra cosa: pasa tal cual (Next resolverá o dará 404).
  return { action: 'next' };
}
