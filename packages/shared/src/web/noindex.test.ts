import { describe, expect, it } from 'vitest';

import {
  isNoindexPath,
  platformRobotsRules,
  ROBOTS_PRIVATE_PATHS,
  tenantRobotsTxt,
  WEB_NOINDEX_PREFIXES,
} from './noindex';

const DISALLOW_RE = /^Disallow:\s*(.*)$/gim;

function disallowedBy(robots: string): string[] {
  return [...robots.matchAll(DISALLOW_RE)].map((m) => (m[1] ?? '').trim());
}

describe('isNoindexPath (B1 / D5)', () => {
  it.each([
    '/reservar',
    '/reservar/mislata',
    '/reservar/mislata/l/en',
    '/book/jota',
    '/portal/login',
    '/portal/consume',
    '/sign/abc',
    '/pay/redsys/ok',
    '/review/abc',
    '/unsubscribe/abc',
    '/widget/jota',
    '/g/ABC123',
    '/dashboard',
    '/settings/billing',
    '/admin/tenants',
  ])('lleva noindex: %s', (path) => {
    expect(isNoindexPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/s/jota',
    '/s/jota/precios',
    '/s/jota/l/en/blog',
    '/precios',
    '/contacto',
    '/mislata',
    '/blog/como-elegir',
    '/aviso-legal',
    '/reservarmas',
    '/payments',
  ])('se indexa: %s', (path) => {
    expect(isNoindexPath(path)).toBe(false);
  });
});

describe('robots.txt no bloquea nada que lleve noindex (B2 / D5)', () => {
  it('la lista privada de robots no contiene rutas con noindex', () => {
    for (const path of ROBOTS_PRIVATE_PATHS) {
      expect(isNoindexPath(path)).toBe(false);
      expect((WEB_NOINDEX_PREFIXES as readonly string[]).includes(path)).toBe(false);
    }
  });

  it('robots de la plataforma: solo bloquea la API cuando está indexable', () => {
    const rules = platformRobotsRules(true);
    expect(rules.disallow).toEqual(['/api/']);
    expect(rules.allow).toEqual(['/', '/s/']);
  });

  it('robots de la plataforma apagada: bloquea la raíz y deja /s/', () => {
    const rules = platformRobotsRules(false);
    expect(rules.disallow).toEqual(['/', '/api/']);
    expect(rules.allow).toEqual(['/s/']);
  });

  it('robots del dominio propio: ninguna ruta con noindex en Disallow', () => {
    const robots = tenantRobotsTxt('https://untrastero.es/sitemap.xml');
    const blocked = disallowedBy(robots);
    expect(blocked).toEqual([]);
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://untrastero.es/sitemap.xml');
    for (const path of blocked) expect(isNoindexPath(path)).toBe(false);
  });
});
