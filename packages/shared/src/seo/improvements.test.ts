import { describe, expect, it } from 'vitest';

import {
  BatchUpdateSeoKeywordsSchema,
  UpdateSeoLocalAreasSchema,
  detectSeoArea,
  isSeoBrandQuery,
  normalizeSeoPathPrefix,
  seoAreaLikePatterns,
  seoBrandLikePatterns,
  seoBrandTerms,
  seoIsLanguagePair,
  seoMobileGap,
  seoSplitLocalePath,
  seoUrlInPath,
} from './improvements';

describe('marca frente a no marca', () => {
  it('limpia los términos y compara sin tildes', () => {
    expect(seoBrandTerms([' TrasterOS ', 'trasteros', 'x', 'trasteros'])).toEqual(['trasteros']);
    expect(isSeoBrandQuery('Guárdalo box valencia', ['guardalo'])).toBe(true);
    expect(isSeoBrandQuery('trasteros baratos', ['guardalo'])).toBe(false);
  });
  it('escapa los comodines de los patrones', () => {
    expect(seoBrandLikePatterns(['50%_off'])).toEqual(['%50\\%\\_off%']);
  });
});

describe('zonas', () => {
  const areas = ['Mislata', 'Valencia', 'Ciudad de Valencia', 'Alboraya'];
  it('detecta la zona por palabras enteras y sin tildes', () => {
    expect(detectSeoArea('trasteros mislata', areas)).toBe('Mislata');
    expect(detectSeoArea('alquiler trastero alboraia', areas)).toBeNull();
    expect(detectSeoArea('trasteros en ciudad de valencia', areas)).toBe('Ciudad de Valencia');
    expect(detectSeoArea('trasteros mislatas', areas)).toBeNull();
  });
  it('da patrones con y sin tildes', () => {
    expect(seoAreaLikePatterns('Alboraya')).toEqual(['%alboraya%']);
    expect(seoAreaLikePatterns('Xàtiva')).toEqual(['%xativa%', '%xàtiva%']);
  });
  it('deja la lista sin repetidos', () => {
    const parsed = UpdateSeoLocalAreasSchema.parse({ areas: ['Mislata', 'mislata', ' Quart '] });
    expect(parsed.areas).toEqual(['Mislata', 'Quart']);
  });
});

describe('móvil frente a ordenador', () => {
  it('marca la página con la mitad de CTR en móvil', () => {
    const r = seoMobileGap(
      { clicks: 5, impressions: 1000, position: 8 },
      { clicks: 40, impressions: 1000, position: 7.5 },
    );
    expect(r.worse).toBe(true);
    expect(r.reason).toContain('CTR');
  });
  it('no marca con poco volumen', () => {
    const r = seoMobileGap(
      { clicks: 0, impressions: 20, position: 20 },
      { clicks: 9, impressions: 20, position: 4 },
    );
    expect(r.worse).toBe(false);
  });
  it('marca la caída de puestos', () => {
    const r = seoMobileGap(
      { clicks: 50, impressions: 1000, position: 11 },
      { clicks: 55, impressions: 1000, position: 6 },
    );
    expect(r.worse).toBe(true);
    expect(r.positionGap).toBe(5);
  });
});

describe('directorio de un competidor', () => {
  it('normaliza la ruta', () => {
    expect(normalizeSeoPathPrefix('competidor.es/Valencia/')).toBe('/valencia/');
    expect(normalizeSeoPathPrefix('https://competidor.es/valencia/centro')).toBe(
      '/valencia/centro/',
    );
    expect(normalizeSeoPathPrefix('/')).toBeNull();
    expect(normalizeSeoPathPrefix('')).toBeNull();
    expect(normalizeSeoPathPrefix('/a b')).toBeNull();
  });
  it('filtra por ruta', () => {
    expect(seoUrlInPath('https://competidor.es/valencia/mislata', '/valencia/')).toBe(true);
    expect(seoUrlInPath('https://competidor.es/valencia', '/valencia/')).toBe(true);
    expect(seoUrlInPath('https://competidor.es/madrid/', '/valencia/')).toBe(false);
    expect(seoUrlInPath('https://competidor.es/madrid/', null)).toBe(true);
  });
});

describe('parejas de idioma', () => {
  it('separa el prefijo de idioma', () => {
    expect(seoSplitLocalePath('https://x.es/l/en/precios')).toEqual({
      path: '/precios',
      locale: 'en',
    });
    expect(seoSplitLocalePath('https://x.es/s/negocio/l/en')).toEqual({
      path: '/s/negocio',
      locale: 'en',
    });
    expect(seoSplitLocalePath('https://x.es/precios')).toEqual({ path: '/precios', locale: null });
  });
  it('reconoce la pareja', () => {
    expect(seoIsLanguagePair('https://x.es/precios', 'https://x.es/l/en/precios')).toBe(true);
    expect(seoIsLanguagePair('https://x.es/precios', 'https://x.es/contacto')).toBe(false);
    expect(seoIsLanguagePair('https://x.es/precios', 'https://x.es/precios')).toBe(false);
  });
});

describe('lote de palabras', () => {
  it('exige algo que cambiar', () => {
    const id = '0190b8f0-0000-7000-8000-000000000000';
    expect(BatchUpdateSeoKeywordsSchema.safeParse({ ids: [id] }).success).toBe(false);
    expect(BatchUpdateSeoKeywordsSchema.safeParse({ ids: [id], priority: 1 }).success).toBe(true);
    expect(BatchUpdateSeoKeywordsSchema.safeParse({ ids: [], priority: 1 }).success).toBe(false);
  });
});
