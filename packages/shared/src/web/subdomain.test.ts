import { describe, expect, it } from 'vitest';

import { decideWebIndexing, subdomainServesWeb } from './indexing';
import {
  isReservedTenantSlug,
  legacySiteRest,
  legacySiteTarget,
  RESERVED_TENANT_SLUGS,
  subdomainRedirectTarget,
  tenantSubdomainOf,
} from './subdomain';

const PLATFORM = 'trasteros.pro';

describe('identificadores reservados', () => {
  it('todos los de la lista de D4 están reservados', () => {
    const decided = [
      'api',
      'www',
      'app',
      'mail',
      'admin',
      'web',
      'static',
      'cdn',
      'files',
      'smtp',
      'ns',
      'ftp',
      'status',
      'docs',
      'help',
      'support',
      'staging',
      'dev',
      'test',
      'demo',
    ];
    expect([...RESERVED_TENANT_SLUGS].sort()).toEqual([...decided].sort());
    for (const slug of decided) expect(isReservedTenantSlug(slug)).toBe(true);
  });

  it('un nombre normal no está reservado, y se compara sin mayúsculas', () => {
    expect(isReservedTenantSlug('guardalo')).toBe(false);
    expect(isReservedTenantSlug('mislata-trasteros')).toBe(false);
    expect(isReservedTenantSlug('API')).toBe(true);
  });
});

describe('tenantSubdomainOf', () => {
  it('saca el identificador de <slug>.<plataforma>', () => {
    expect(tenantSubdomainOf('guardalo.trasteros.pro', PLATFORM)).toBe('guardalo');
    expect(tenantSubdomainOf('Guardalo.Trasteros.PRO', PLATFORM)).toBe('guardalo');
  });

  it('ignora el puerto (desarrollo: slug.localhost:3000)', () => {
    expect(tenantSubdomainOf('demo-x.localhost:3100', 'localhost:3000')).toBe('demo-x');
    expect(tenantSubdomainOf('localhost:3000', 'localhost:3000')).toBeNull();
  });

  it('no es subdominio de negocio: la raíz, un dominio ajeno, varios niveles o un reservado', () => {
    expect(tenantSubdomainOf('trasteros.pro', PLATFORM)).toBeNull();
    expect(tenantSubdomainOf('guardalo.es', PLATFORM)).toBeNull();
    expect(tenantSubdomainOf('a.b.trasteros.pro', PLATFORM)).toBeNull();
    expect(tenantSubdomainOf('api.trasteros.pro', PLATFORM)).toBeNull();
    expect(tenantSubdomainOf('www.trasteros.pro', PLATFORM)).toBeNull();
    expect(tenantSubdomainOf('', PLATFORM)).toBeNull();
  });

  it('un host que solo termina igual (sin punto) no cuenta', () => {
    expect(tenantSubdomainOf('guardalotrasteros.pro', PLATFORM)).toBeNull();
  });
});

describe('legacySiteRest y destino del 308 de /s/<slug>', () => {
  it('quita el prefijo y la barra final', () => {
    expect(legacySiteRest('/s/guardalo', 'guardalo')).toBe('/');
    expect(legacySiteRest('/s/guardalo/', 'guardalo')).toBe('/');
    expect(legacySiteRest('/s/guardalo/aviso-legal', 'guardalo')).toBe('/aviso-legal');
    expect(legacySiteRest('/s/guardalo/l/en/', 'guardalo')).toBe('/l/en');
    expect(legacySiteRest('/s/otro', 'guardalo')).toBeNull();
    expect(legacySiteRest('/s/guardalox', 'guardalo')).toBeNull();
  });

  it('sin dominio propio: al subdominio del negocio con la misma ruta', () => {
    expect(
      legacySiteTarget({
        pathname: '/s/guardalo/mislata',
        search: '?utm_source=x',
        slug: 'guardalo',
        customDomain: null,
        platformHost: PLATFORM,
      }),
    ).toEqual({ host: 'guardalo.trasteros.pro', path: '/mislata?utm_source=x' });
  });

  it('con dominio propio verificado: a ese dominio, misma ruta y query', () => {
    expect(
      legacySiteTarget({
        pathname: '/s/guardalo/precios',
        search: '',
        slug: 'guardalo',
        customDomain: 'guardalo.es',
        platformHost: PLATFORM,
      }),
    ).toEqual({ host: 'guardalo.es', path: '/precios' });
  });

  it('una ruta que no es de ese negocio no tiene destino', () => {
    expect(
      legacySiteTarget({
        pathname: '/login',
        search: '',
        slug: 'guardalo',
        customDomain: null,
        platformHost: PLATFORM,
      }),
    ).toBeNull();
  });

  it('subdominio con dominio propio: 308 a ese dominio con la misma ruta y query', () => {
    expect(
      subdomainRedirectTarget({
        customDomain: 'guardalo.es',
        pathname: '/reservar/mislata',
        search: '?unitTypeId=1',
      }),
    ).toEqual({ host: 'guardalo.es', path: '/reservar/mislata?unitTypeId=1' });
  });
});

describe('subdomainServesWeb (regla de decideWebIndexing)', () => {
  it('sirve solo si la web está publicada y el negocio está activo o en prueba', () => {
    expect(subdomainServesWeb({ webPublished: true, status: 'active' })).toBe(true);
    expect(subdomainServesWeb({ webPublished: true, status: 'trial' })).toBe(true);
    expect(subdomainServesWeb({ webPublished: false, status: 'active' })).toBe(false);
  });

  it('suspendido (a cualquier día) o dado de baja: 404', () => {
    expect(subdomainServesWeb({ webPublished: true, status: 'suspended' })).toBe(false);
    expect(subdomainServesWeb({ webPublished: true, status: 'cancelled' })).toBe(false);
  });

  it('coincide con la regla de indexación en automático para negocios vivos', () => {
    for (const status of ['trial', 'active'] as const) {
      const live = decideWebIndexing({
        webPublished: true,
        status,
        isDemo: false,
        suspendedDays: null,
        mode: 'auto',
      });
      expect(subdomainServesWeb({ webPublished: true, status })).toBe(live.indexable);
    }
  });
});
