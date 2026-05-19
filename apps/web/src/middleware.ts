import { type NextRequest, NextResponse } from 'next/server';

/**
 * Middleware de proteccion de rutas autenticadas.
 *
 * Si el navegador no envia la cookie `refresh_token`, redirige a /login
 * con `?next=...` para volver tras autenticarse. Si la cookie existe pero
 * esta caducada o revocada, el AuthBootstrap del layout `(app)` se
 * encarga de redirigir.
 */
const PROTECTED = ['/dashboard', '/settings'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
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
  matcher: ['/dashboard/:path*', '/settings/:path*'],
};
