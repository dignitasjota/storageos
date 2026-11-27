import { describe, expect, it } from 'vitest';

import { tenantPageUrl } from './tenant-url';

describe('tenantPageUrl (B3: canónica sin barra final)', () => {
  it('sin dominio propio, la portada es /s/<slug> sin barra', () => {
    expect(tenantPageUrl('/s/jota')).toBe('/s/jota');
  });

  it('sin dominio propio, la versión en inglés no lleva barra', () => {
    expect(tenantPageUrl('/s/jota', 'l/en')).toBe('/s/jota/l/en');
  });

  it('con dominio propio, la raíz lleva barra (forma normal de la URL)', () => {
    expect(tenantPageUrl('https://untrastero.es')).toBe('https://untrastero.es/');
  });

  it('con dominio propio, las páginas cuelgan sin barra doble', () => {
    expect(tenantPageUrl('https://untrastero.es', 'l/en')).toBe('https://untrastero.es/l/en');
    expect(tenantPageUrl('https://untrastero.es', 'precios')).toBe('https://untrastero.es/precios');
  });

  it('nunca termina en barra salvo la raíz de un dominio propio', () => {
    for (const base of ['/s/a', 'https://a.es']) {
      for (const suffix of ['', 'l/en', 'precios', 'contacto']) {
        const url = tenantPageUrl(base, suffix);
        if (suffix === '' && base.startsWith('https')) continue;
        expect(url.endsWith('/')).toBe(false);
      }
    }
  });
});
