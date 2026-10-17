import { describe, expect, it } from 'vitest';

import { cityFromPageSlug, cityPages, citySlug } from './city-pages';

describe('páginas por ciudad', () => {
  it('slug sin tildes ni espacios', () => {
    expect(citySlug('Alcalá de Henares')).toBe('alcala-de-henares');
    expect(citySlug(' L’Hospitalet ')).toBe('l-hospitalet');
  });

  it('agrupa por ciudad y exige al menos dos locales', () => {
    expect(cityPages([{ city: 'Valencia' }])).toEqual([]);
    const pages = cityPages([
      { city: 'Valencia', id: 1 },
      { city: 'valencia', id: 2 },
      { city: 'Mislata', id: 3 },
      { city: null, id: 4 },
    ]);
    expect(pages.map((p) => [p.slug, p.facilities.length])).toEqual([
      ['mislata', 1],
      ['valencia', 2],
    ]);
  });

  it('lee la ciudad de la dirección', () => {
    expect(cityFromPageSlug('trasteros-en-valencia')).toBe('valencia');
    expect(cityFromPageSlug('local-centro')).toBeNull();
    expect(cityFromPageSlug('trasteros-en-')).toBeNull();
  });
});
