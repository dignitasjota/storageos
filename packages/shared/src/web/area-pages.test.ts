import { describe, expect, it } from 'vitest';

import {
  areaPageShownOnFacility,
  cityPageOfFacility,
  resolveAreaPages,
  wordCount,
  type PublicAreaPageContentDto,
} from './area-pages';

const fac = (id: string, city: string | null, publicSlug: string | null = id) => ({
  id,
  city,
  publicSlug,
});
const content = (
  slug: string,
  extra: Partial<PublicAreaPageContentDto> = {},
): PublicAreaPageContentDto => ({
  slug,
  name: slug,
  facilityIds: [],
  nearestNote: null,
  intro: null,
  nearbyAreas: [],
  faqs: [],
  seoTitle: null,
  seoDescription: null,
  ...extra,
});

describe('páginas de zona', () => {
  it('con un solo local, la ciudad lleva a la portada', () => {
    const [page] = resolveAreaPages([fac('a', 'Mislata')], []);
    expect(page).toMatchObject({ slug: 'mislata', redirect: { to: 'home' }, indexable: false });
  });

  it('una ciudad con un solo local lleva a su ficha y la ficha muestra su texto', () => {
    const pages = resolveAreaPages(
      [fac('a', 'Mislata', 'centro-mislata'), fac('b', 'Valencia'), fac('c', 'valencia')],
      [content('mislata', { intro: 'Texto' })],
    );
    const mislata = pages.find((p) => p.slug === 'mislata');
    expect(mislata?.redirect).toEqual({ to: 'facility', publicSlug: 'centro-mislata' });
    expect(areaPageShownOnFacility(pages, 'a')?.content?.intro).toBe('Texto');
    expect(cityPageOfFacility(pages, 'a')).toBeNull();
    expect(cityPageOfFacility(pages, 'b')?.slug).toBe('valencia');
    expect(pages.find((p) => p.slug === 'valencia')).toMatchObject({
      redirect: null,
      indexable: true,
    });
  });

  it('una zona cercana solo se indexa con texto propio suficiente', () => {
    const long = Array.from({ length: 130 }, (_, i) => `palabra${i}`).join(' ');
    const pages = resolveAreaPages(
      [fac('a', 'Mislata')],
      [
        content('paterna', { facilityIds: ['a'], intro: long }),
        content('xirivella', { facilityIds: ['a'], intro: 'poco texto' }),
        content('torrent', { facilityIds: ['otro'] }),
      ],
    );
    expect(pages.find((p) => p.slug === 'paterna')).toMatchObject({
      kind: 'nearby',
      indexable: true,
    });
    expect(pages.find((p) => p.slug === 'xirivella')?.indexable).toBe(false);
    // Sin locales que mostrar no existe.
    expect(pages.find((p) => p.slug === 'torrent')).toBeUndefined();
  });

  it('cuenta palabras sin signos sueltos', () => {
    expect(wordCount('Trasteros en Mislata — desde 39 €')).toBe(5);
    expect(wordCount(null)).toBe(0);
  });
});
