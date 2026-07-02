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
