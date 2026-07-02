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

// Caché host → slug (o null) con TTL corto. En self-hosted (proceso node) el
// estado del módulo persiste entre requests; si se recicla, se re-resuelve.
const domainCache = new Map<string, { slug: string | null; exp: number }>();
const DOMAIN_TTL_MS = 60_000;

async function resolveSlug(host: string): Promise<string | null> {
  const now = Date.now();
  const cached = domainCache.get(host);
  if (cached && cached.exp > now) return cached.slug;
  let slug: string | null = null;
  try {
    const res = await fetch(
      `${API_URL}/public/landing/resolve-domain?host=${encodeURIComponent(host)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { tenantSlug?: string };
      slug = data.tenantSlug ?? null;
    }
  } catch {
    slug = null;
  }
  domainCache.set(host, { slug, exp: now + DOMAIN_TTL_MS });
  return slug;
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
    const slug = await resolveSlug(host);
    if (slug) {
      const route = resolveCustomDomainRoute(pathname, slug);
      if (route.action === 'rewrite') {
        const url = req.nextUrl.clone();
        url.pathname = route.path;
        return NextResponse.rewrite(url);
      }
      if (route.action === 'redirectToPlatform' && PLATFORM_HOST) {
        return NextResponse.redirect(
          new URL(`${pathname}${search}`, `https://${PLATFORM_HOST}`),
          308,
        );
      }
      return NextResponse.next();
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
