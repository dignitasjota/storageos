import { isNoindexPath, resolveCustomDomainRoute } from '@storageos/shared';
import { type NextRequest, NextResponse } from 'next/server';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/**
 * Middleware combinado:
 *
 * 1. Dominio propio de tenant (white-label): si el `Host` no es el de la
 *    plataforma, resuelve el `slug` del tenant (con caché) y reescribe/redirige
 *    según `resolveCustomDomainRoute` (la raíz sirve la landing del tenant, las
 *    rutas de panel van al dominio de la plataforma, el resto pasa tal cual).
 * 2. Protege rutas autenticadas (/dashboard, /settings): redirige a /login si
 *    no hay refresh cookie.
 * 3. Para /widget/*: aplica cabeceras CSP que permiten el embebido en iframe.
 */
const PROTECTED = ['/dashboard', '/settings'];

/**
 * Páginas sin valor para los buscadores (acceso, enlaces de un solo uso, reserva,
 * pagos, portal, panel…), también en los dominios propios de los tenants: se
 * piden «no indexar» con `X-Robots-Tag` (muchas son componentes de cliente que
 * no pueden declarar metadatos). La lista vive en `@storageos/shared`: la usan
 * también las metaetiquetas, `robots.txt` y SEO Avanzado. La ruta que se mira
 * es la que ve el navegador (`/reservar…`), no la reescrita (`/book/…`).
 */
function withNoindex(pathname: string, res: NextResponse): NextResponse {
  if (isNoindexPath(pathname)) {
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return res;
}
const API_URL = SERVER_API_URL;

function hostFromUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

const PLATFORM_HOST = hostFromUrl(
  process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_WEB_URL,
);

/** ¿El host es el de la plataforma (o dev: localhost / IP)? */
function isPlatformHost(host: string): boolean {
  const name = host.split(':')[0] ?? '';
  if (PLATFORM_HOST && host === PLATFORM_HOST) return true;
  return name === 'localhost' || name === '127.0.0.1' || /^[0-9.]+$/.test(name);
}

interface DomainResolution {
  slug: string | null;
  hasExternalSite: boolean;
  /** El dominio guardado: la forma con o sin `www.` redirige a él. */
  canonicalHost: string | null;
}

// Caché host → resolución con TTL corto. En self-hosted (proceso node) el
// estado del módulo persiste entre requests; si se recicla, se re-resuelve.
const domainCache = new Map<string, { value: DomainResolution; exp: number }>();
const DOMAIN_TTL_MS = 60_000;
const DOMAIN_CACHE_MAX = 2_000;

async function resolveSlug(host: string): Promise<DomainResolution> {
  const now = Date.now();
  const cached = domainCache.get(host);
  if (cached && cached.exp > now) return cached.value;
  let value: DomainResolution = { slug: null, hasExternalSite: false, canonicalHost: null };
  try {
    const res = await fetch(
      `${API_URL}/public/landing/resolve-domain?host=${encodeURIComponent(host)}`,
      { headers: internalApiHeaders() },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        tenantSlug?: string;
        hasExternalSite?: boolean;
        canonicalHost?: string;
      };
      value = {
        slug: data.tenantSlug ?? null,
        hasExternalSite: data.hasExternalSite ?? false,
        canonicalHost: data.canonicalHost ?? null,
      };
    }
  } catch {
    value = { slug: null, hasExternalSite: false, canonicalHost: null };
  }
  // Tamaño máximo: cualquiera puede mandar peticiones con un `Host` inventado
  // y la caché no debe crecer sin límite (se descarta la entrada más antigua).
  if (domainCache.size >= DOMAIN_CACHE_MAX) {
    const oldest = domainCache.keys().next().value;
    if (oldest !== undefined) domainCache.delete(oldest);
  }
  domainCache.set(host, { value, exp: now + DOMAIN_TTL_MS });
  return value;
}

/**
 * Cabeceras que solo pone este middleware (dominio propio del tenant). Si las
 * manda el navegador se quitan: con ellas cualquiera podía servir en la
 * plataforma páginas que solo existen en un dominio propio.
 */
const INTERNAL_HEADERS = [
  'x-storageos-tenant-slug',
  'x-storageos-tenant-public',
  'x-storageos-head',
  'x-storageos-pathname',
];

function cleanHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  for (const h of INTERNAL_HEADERS) headers.delete(h);
  // Una petición HEAD solo comprueba el enlace (no es una visita): las páginas
  // no ven el método, así que se lo dice esta cabecera (el QR no cuenta el clic).
  if (req.method === 'HEAD') headers.set('x-storageos-head', '1');
  // La ruta que pidió el navegador (la reescrita no se ve desde una página 404):
  // la página 404 la usa para elegir la neutral de los negocios o la de la plataforma.
  headers.set('x-storageos-pathname', req.nextUrl.pathname);
  return headers;
}

/** Sigue con la petición, sin las cabeceras internas que trajera el navegador. */
function passThrough(req: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: cleanHeaders(req) } });
}

/** El widget se incrusta en webs ajenas: se permite mostrarlo en un iframe. */
function allowWidgetFraming(res: NextResponse): NextResponse {
  res.headers.set('X-Frame-Options', 'ALLOWALL');
  res.headers.set(
    'Content-Security-Policy',
    "frame-ancestors *; default-src 'self' 'unsafe-inline' data:; img-src 'self' data: https:; connect-src 'self' http: https:;",
  );
  return res;
}

function platformProtection(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/widget/')) return allowWidgetFraming(passThrough(req));

  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isProtected) return passThrough(req);

  const refresh = req.cookies.get('refresh_token');
  if (refresh && refresh.value) return passThrough(req);
  // Sesión de soporte abierta desde el panel admin: el token vive en la pestaña
  // (sessionStorage), no en cookie. Esta marca solo evita mandar al login; sin
  // token válido, la propia página lleva al login.
  if (
    req.cookies.get('storageos_impersonation')?.value ||
    req.nextUrl.searchParams.has('impersonation')
  ) {
    return passThrough(req);
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const host = (req.headers.get('host') ?? '').toLowerCase();
  const { pathname, search } = req.nextUrl;

  // --- Dominio propio de tenant (white-label) ---
  if (host && !isPlatformHost(host)) {
    const { slug, hasExternalSite, canonicalHost } = await resolveSlug(host);
    // Con y sin `www.`: la forma que no se guardó redirige a la guardada.
    if (slug && canonicalHost && canonicalHost !== host.split(':')[0]) {
      return NextResponse.redirect(
        new URL(`${pathname}${search}`, `https://${canonicalHost}`),
        308,
      );
    }
    if (slug) {
      const route = resolveCustomDomainRoute(pathname, slug, { externalSite: hasExternalSite });
      // El tenant se identifica SIEMPRE por esta cabecera cuando se accede vía
      // su dominio propio (portal, login, cualquier página pública) — no
      // depende de que la URL lleve `?slug=` (que nuestras plantillas añaden,
      // pero una web externa del tenant o un enlace tecleado a mano no).
      const headers = cleanHeaders(req);
      headers.set('x-storageos-tenant-slug', slug);
      if (route.action === 'rewrite') {
        const url = req.nextUrl.clone();
        url.pathname = route.path;
        // El rewrite es invisible para el navegador (la URL sigue siendo `/` o
        // `/reservar`): `usePathname()` en el cliente vería la ruta original,
        // no `route.path` — por eso se marca con una cabecera para que el
        // layout público (server) fuerce el marco "sin plataforma".
        headers.set('x-storageos-tenant-public', '1');
        return withNoindex(pathname, NextResponse.rewrite(url, { request: { headers } }));
      }
      if (route.action === 'redirectToPlatform' && PLATFORM_HOST) {
        return NextResponse.redirect(
          new URL(`${pathname}${search}`, `https://${PLATFORM_HOST}`),
          308,
        );
      }
      const res = NextResponse.next({ request: { headers } });
      return withNoindex(pathname, pathname.startsWith('/widget/') ? allowWidgetFraming(res) : res);
    }
    // Host no resoluble (dominio no registrado/verificado): pasa tal cual.
  }

  // --- Dominio de la plataforma: protección de rutas + widget ---
  return withNoindex(pathname, platformProtection(req));
}

export const config = {
  // Corre en todo salvo los assets internos de Next (para detectar el Host en
  // cualquier ruta de un dominio propio). El coste en el dominio de plataforma
  // es una comprobación de host + prefijos (sin fetch).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
