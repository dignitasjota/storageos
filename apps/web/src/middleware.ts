import { resolveCustomDomainRoute } from '@storageos/shared';
import { type NextRequest, NextResponse } from 'next/server';

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
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
}

// Caché host → resolución con TTL corto. En self-hosted (proceso node) el
// estado del módulo persiste entre requests; si se recicla, se re-resuelve.
const domainCache = new Map<string, { value: DomainResolution; exp: number }>();
const DOMAIN_TTL_MS = 60_000;

async function resolveSlug(host: string): Promise<DomainResolution> {
  const now = Date.now();
  const cached = domainCache.get(host);
  if (cached && cached.exp > now) return cached.value;
  let value: DomainResolution = { slug: null, hasExternalSite: false };
  try {
    const res = await fetch(
      `${API_URL}/public/landing/resolve-domain?host=${encodeURIComponent(host)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { tenantSlug?: string; hasExternalSite?: boolean };
      value = { slug: data.tenantSlug ?? null, hasExternalSite: data.hasExternalSite ?? false };
    }
  } catch {
    value = { slug: null, hasExternalSite: false };
  }
  domainCache.set(host, { value, exp: now + DOMAIN_TTL_MS });
  return value;
}

function platformProtection(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/widget/')) {
    const res = NextResponse.next();
    res.headers.set('X-Frame-Options', 'ALLOWALL');
    res.headers.set(
      'Content-Security-Policy',
      "frame-ancestors *; default-src 'self' 'unsafe-inline' data:; img-src 'self' data: https:; connect-src 'self' http: https:;",
    );
    return res;
  }

  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isProtected) return NextResponse.next();

  const refresh = req.cookies.get('refresh_token');
  if (refresh && refresh.value) return NextResponse.next();

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
    const { slug, hasExternalSite } = await resolveSlug(host);
    if (slug) {
      const route = resolveCustomDomainRoute(pathname, slug, { externalSite: hasExternalSite });
      // El tenant se identifica SIEMPRE por esta cabecera cuando se accede vía
      // su dominio propio (portal, login, cualquier página pública) — no
      // depende de que la URL lleve `?slug=` (que nuestras plantillas añaden,
      // pero una web externa del tenant o un enlace tecleado a mano no).
      const headers = new Headers(req.headers);
      headers.set('x-storageos-tenant-slug', slug);
      if (route.action === 'rewrite') {
        const url = req.nextUrl.clone();
        url.pathname = route.path;
        // El rewrite es invisible para el navegador (la URL sigue siendo `/` o
        // `/reservar`): `usePathname()` en el cliente vería la ruta original,
        // no `route.path` — por eso se marca con una cabecera para que el
        // layout público (server) fuerce el marco "sin plataforma".
        headers.set('x-storageos-tenant-public', '1');
        return NextResponse.rewrite(url, { request: { headers } });
      }
      if (route.action === 'redirectToPlatform' && PLATFORM_HOST) {
        return NextResponse.redirect(
          new URL(`${pathname}${search}`, `https://${PLATFORM_HOST}`),
          308,
        );
      }
      return NextResponse.next({ request: { headers } });
    }
    // Host no resoluble (dominio no registrado/verificado): pasa tal cual.
  }

  // --- Dominio de la plataforma: protección de rutas + widget ---
  return platformProtection(req);
}

export const config = {
  // Corre en todo salvo los assets internos de Next (para detectar el Host en
  // cualquier ruta de un dominio propio). El coste en el dominio de plataforma
  // es una comprobación de host + prefijos (sin fetch).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
