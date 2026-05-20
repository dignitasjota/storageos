import { type NextRequest, NextResponse } from 'next/server';

/**
 * Middleware combinado:
 *
 * 1. Protege rutas autenticadas (/dashboard, /settings, /...): redirige a
 *    /login si no hay refresh cookie.
 * 2. Para /widget/*: NO redirige, pero aplica cabeceras CSP que permiten
 *    el embebido en iframe desde cualquier origen, para que el widget
 *    publico se pueda integrar en webs de terceros.
 */
const PROTECTED = ['/dashboard', '/settings'];

export function middleware(req: NextRequest) {
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

export const config = {
  matcher: ['/dashboard/:path*', '/settings/:path*', '/widget/:path*'],
};
