import { describe, expect, it } from 'vitest';

import { seoLandingKey, seoPageLandingKey } from './conversions';
import { normalizeSeoGa4Rows } from './ga4';

describe('clave de la página de entrada', () => {
  it('en un negocio, su web en la plataforma cuenta como su propia ruta', () => {
    expect(seoPageLandingKey('https://trasteros.pro/s/guardalo')).toBe('/');
    expect(seoPageLandingKey('https://trasteros.pro/s/guardalo/precios')).toBe('/precios');
  });

  it('en la plataforma, las webs de los negocios no se suman a sus páginas', () => {
    expect(seoPageLandingKey('https://trasteros.pro/', true)).toBe('/');
    expect(seoPageLandingKey('https://trasteros.pro/s/guardalo', true)).toBe('/s/guardalo');
    expect(seoPageLandingKey('https://trasteros.pro/s/otro/precios', true)).toBe('/s/otro/precios');
    expect(seoLandingKey('/precios?utm=x', true)).toBe('/precios');
  });

  it('GA4 de la plataforma: /s/<negocio> queda aparte de la portada', () => {
    const row = (landing: string) => ({
      date: '2026-11-01',
      host: 'trasteros.pro',
      landing,
      sessions: 10,
      users: 8,
      engagedSessions: 5,
      averageSessionDuration: 30,
      pageViews: 12,
      keyEvents: 0,
    });
    const out = normalizeSeoGa4Rows([row('/'), row('/s/guardalo')], true);
    expect(out.map((r) => r.landingPath).sort()).toEqual(['/', '/s/guardalo']);
    const merged = normalizeSeoGa4Rows([row('/'), row('/s/guardalo')]);
    expect(merged.map((r) => r.landingPath)).toEqual(['/']);
    expect(merged[0]!.sessions).toBe(20);
  });
});
