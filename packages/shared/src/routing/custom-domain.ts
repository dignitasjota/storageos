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

/**
 * Secciones de la web de una página con dirección propia en el dominio del
 * tenant (las usan las campañas de Google Ads): cargan la web y bajan solas a
 * la sección. Se sirven con `/s/<slug>/<sección>` (regla de 1 segmento).
 */
export const LANDING_SECTION_PATHS = ['contacto', 'precios'] as const;
export type LandingSection = (typeof LANDING_SECTION_PATHS)[number];

/** Ruta amigable de reserva en el dominio propio → booking del tenant. */
const BOOK_ALIAS = '/reservar';

/** Landings de promoción: `/promo/<nombre>` en el dominio propio. */
export const PROMO_PREFIX = 'promo';

/**
 * Segmentos que un `publicSlug` de facility NUNCA puede usar bajo un dominio
 * propio: colisionarían con una ruta real (reescrita ANTES que la regla
 * genérica de 1 segmento en `resolveCustomDomainRoute` — portal/login/
 * reserva/etc. siempre ganan) y ese local quedaría inalcanzable en
 * `midominio.com/<slug>`. Fuente única derivada de los mismos prefijos que
 * usa el resolver, más `l`/`blog` — los 2 segmentos "de sitio" que no vienen
 * de un prefijo sino de carpetas reales bajo `/s/[slug]/` (idioma y blog).
 */
export const RESERVED_FACILITY_SLUGS: ReadonlySet<string> = new Set([
  ...PASS_PREFIXES.map((p) => p.slice(1)),
  ...PLATFORM_PREFIXES.map((p) => p.slice(1)),
  BOOK_ALIAS.slice(1),
  'l',
  'blog',
  PROMO_PREFIX,
  // Direcciones fijas de la web (`/contacto`, `/precios`) para campañas.
  ...LANDING_SECTION_PATHS,
]);

/**
 * `/reservar[/<centro>][/l/<idioma>]` → `/book/<slug>[/l/<idioma>]`. El centro
 * no viaja en la ruta reescrita: la página de reserva lo lee de la URL que ve
 * el navegador (`bookCentroFromPath`) y lo deja preseleccionado.
 */
function bookRewritePath(pathname: string, slug: string): string {
  const rest = pathname.slice(BOOK_ALIAS.length).split('/').filter(Boolean);
  const localeAt = rest[0] === 'l' ? 0 : rest[1] === 'l' ? 1 : -1;
  const locale = localeAt >= 0 ? rest[localeAt + 1] : undefined;
  return locale ? `/book/${slug}/l/${locale}` : `/book/${slug}`;
}

/**
 * Centro de una URL de reserva del dominio propio (`/reservar/mislata` →
 * `mislata`), o null (`/reservar`, `/reservar/l/en`, otra ruta).
 */
export function bookCentroFromPath(pathname: string): string | null {
  if (!matchesPrefix(pathname, BOOK_ALIAS)) return null;
  const first = pathname.slice(BOOK_ALIAS.length).split('/').filter(Boolean)[0];
  if (!first || first === 'l') return null;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

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
    return { action: 'rewrite', path: bookRewritePath(pathname, slug) };
  }

  // Landing de promoción (`/promo/<nombre>`): la pinta la plataforma, también
  // para quien tiene una web externa (los flyers y anuncios apuntan aquí).
  const promoParts = pathname.split('/').filter(Boolean);
  if (promoParts[0] === PROMO_PREFIX && promoParts.length === 2) {
    return { action: 'rewrite', path: `/s/${slug}/${PROMO_PREFIX}/${promoParts[1]}` };
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

  // Un único segmento (p. ej. `/local-norte`, o `/blog`) → página del local
  // del tenant o el listado del blog.
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1) {
    return { action: 'rewrite', path: `/s/${slug}/${segments[0]}` };
  }

  // Entrada del blog (`/blog/<postSlug>`, dos segmentos).
  if (segments.length === 2 && segments[0] === 'blog') {
    return { action: 'rewrite', path: `/s/${slug}/blog/${segments[1]}` };
  }

  // Cualquier otra cosa: pasa tal cual (Next resolverá o dará 404).
  return { action: 'next' };
}
