import { describe, expect, it } from 'vitest';

import { resolveCustomDomainRoute } from './custom-domain';

const SLUG = 'garcia';

describe('resolveCustomDomainRoute', () => {
  it('raíz → reescribe a la landing del tenant', () => {
    expect(resolveCustomDomainRoute('/', SLUG)).toEqual({
      action: 'rewrite',
      path: '/s/garcia',
    });
  });

  it('alias /reservar → reescribe al booking del tenant', () => {
    expect(resolveCustomDomainRoute('/reservar', SLUG)).toEqual({
      action: 'rewrite',
      path: '/book/garcia',
    });
    expect(resolveCustomDomainRoute('/reservar/paso-2', SLUG)).toEqual({
      action: 'rewrite',
      path: '/book/garcia',
    });
  });

  it('un segmento suelto → reescribe a la página del local', () => {
    expect(resolveCustomDomainRoute('/local-norte', SLUG)).toEqual({
      action: 'rewrite',
      path: '/s/garcia/local-norte',
    });
  });

  it('/blog (un segmento) → reescribe al listado del blog', () => {
    expect(resolveCustomDomainRoute('/blog', SLUG)).toEqual({
      action: 'rewrite',
      path: '/s/garcia/blog',
    });
  });

  it('/blog/<postSlug> (dos segmentos) → reescribe a la entrada del blog', () => {
    expect(resolveCustomDomainRoute('/blog/como-organizar-tu-trastero', SLUG)).toEqual({
      action: 'rewrite',
      path: '/s/garcia/blog/como-organizar-tu-trastero',
    });
  });

  it('rutas públicas del inquilino pasan tal cual', () => {
    for (const p of ['/portal', '/portal/consume', '/sign/abc', '/pay/redsys/ok', '/review/tok']) {
      expect(resolveCustomDomainRoute(p, SLUG)).toEqual({ action: 'next' });
    }
  });

  it('la landing y el booking directos pasan tal cual (no se re-reescriben)', () => {
    expect(resolveCustomDomainRoute('/s/garcia', SLUG)).toEqual({ action: 'next' });
    expect(resolveCustomDomainRoute('/book/garcia', SLUG)).toEqual({ action: 'next' });
  });

  it('rutas de panel/auth/admin → redirect a la plataforma', () => {
    for (const p of ['/login', '/dashboard', '/settings/branding', '/admin/tenants', '/register']) {
      expect(resolveCustomDomainRoute(p, SLUG)).toEqual({
        action: 'redirectToPlatform',
        path: p,
      });
    }
  });

  it('assets y ficheros estáticos pasan tal cual', () => {
    for (const p of [
      '/_next/static/chunk.js',
      '/api/csp-report',
      '/sw.js',
      '/manifest.webmanifest',
      '/icon.svg',
      '/robots.txt',
      '/sitemap.xml',
      '/favicon.ico',
    ]) {
      expect(resolveCustomDomainRoute(p, SLUG)).toEqual({ action: 'next' });
    }
  });

  it('rutas multi-segmento no reconocidas pasan tal cual', () => {
    expect(resolveCustomDomainRoute('/algo/profundo/aqui', SLUG)).toEqual({ action: 'next' });
  });
});

describe('resolveCustomDomainRoute — modo web externa (opts.externalSite)', () => {
  const opts = { externalSite: true };

  it('raíz → reescribe al proxy sin ruta extra', () => {
    expect(resolveCustomDomainRoute('/', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/tenant-site/garcia',
    });
  });

  it('ficheros (style.css, imágenes en subcarpetas…) → reescriben al proxy con la ruta completa', () => {
    expect(resolveCustomDomainRoute('/style.css', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/tenant-site/garcia/style.css',
    });
    expect(resolveCustomDomainRoute('/img/logo.png', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/tenant-site/garcia/img/logo.png',
    });
  });

  it('rutas anidadas arbitrarias (subpáginas de su web) → reescriben al proxy', () => {
    expect(resolveCustomDomainRoute('/sobre-nosotros', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/tenant-site/garcia/sobre-nosotros',
    });
    expect(resolveCustomDomainRoute('/blog/2026/post', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/tenant-site/garcia/blog/2026/post',
    });
  });

  it('el alias /reservar sigue siendo del booking de la plataforma, no del proxy', () => {
    expect(resolveCustomDomainRoute('/reservar', SLUG, opts)).toEqual({
      action: 'rewrite',
      path: '/book/garcia',
    });
  });

  it('portal/firma/pago/reseña siguen intactos', () => {
    for (const p of ['/portal', '/portal/consume', '/sign/abc', '/pay/redsys/ok', '/review/tok']) {
      expect(resolveCustomDomainRoute(p, SLUG, opts)).toEqual({ action: 'next' });
    }
  });

  it('panel/auth/admin siguen redirigiendo a la plataforma', () => {
    expect(resolveCustomDomainRoute('/dashboard', SLUG, opts)).toEqual({
      action: 'redirectToPlatform',
      path: '/dashboard',
    });
  });

  it('_next y /api siempre pasan tal cual (incluso con externalSite)', () => {
    expect(resolveCustomDomainRoute('/_next/static/chunk.js', SLUG, opts)).toEqual({
      action: 'next',
    });
    expect(resolveCustomDomainRoute('/api/csp-report', SLUG, opts)).toEqual({ action: 'next' });
  });

  it('sin opts (o externalSite:false), el comportamiento no cambia', () => {
    expect(resolveCustomDomainRoute('/style.css', SLUG)).toEqual({ action: 'next' });
    expect(resolveCustomDomainRoute('/style.css', SLUG, { externalSite: false })).toEqual({
      action: 'next',
    });
    expect(resolveCustomDomainRoute('/local-norte', SLUG, { externalSite: false })).toEqual({
      action: 'rewrite',
      path: '/s/garcia/local-norte',
    });
  });
});
