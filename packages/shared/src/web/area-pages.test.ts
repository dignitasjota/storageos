import { describe, expect, it } from 'vitest';

import {
  areaPageLinks,
  cityPageOfFacility,
  cityPageReplacingFacility,
  parseAreaPageDraft,
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

  it('una ciudad con un solo local se queda con la ficha y la ficha redirige a ella', () => {
    const pages = resolveAreaPages(
      [fac('a', 'Mislata', 'centro-mislata'), fac('b', 'Valencia'), fac('c', 'valencia')],
      [content('mislata', { intro: 'Texto' })],
    );
    const mislata = pages.find((p) => p.slug === 'mislata');
    expect(mislata).toMatchObject({ redirect: null, indexable: true });
    expect(mislata?.soleFacility?.id).toBe('a');
    expect(cityPageReplacingFacility(pages, 'a')?.content?.intro).toBe('Texto');
    expect(cityPageReplacingFacility(pages, 'b')).toBeNull();
    expect(cityPageOfFacility(pages, 'a')).toBeNull();
    expect(cityPageOfFacility(pages, 'b')?.slug).toBe('valencia');
    expect(pages.find((p) => p.slug === 'valencia')).toMatchObject({
      redirect: null,
      soleFacility: null,
      indexable: true,
    });
    expect(areaPageLinks(pages).map((l) => l.path)).toEqual([
      'trasteros-en-mislata',
      'trasteros-en-valencia',
    ]);
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

describe('borrador con IA de una página de zona', () => {
  it('lee el JSON aunque venga entre texto y recorta a los límites', () => {
    const text = `Aquí tienes:\n\`\`\`json\n${JSON.stringify({
      intro: 'Texto de la zona.',
      nearestNote: 'A 8 km.',
      nearbyAreas: ['Xirivella', '', 'x'.repeat(80)],
      faqs: [{ question: '¿Hay furgoneta?', answer: 'Sí.' }, { question: 'Mal' }],
      seoTitle: 'Trasteros cerca de Paterna '.repeat(5),
      seoDescription: 'Descripción',
    })}\n\`\`\``;
    const draft = parseAreaPageDraft(text, 'nearby');
    expect(draft?.intro).toBe('Texto de la zona.');
    expect(draft?.nearestNote).toBe('A 8 km.');
    expect(draft?.nearbyAreas).toHaveLength(2);
    expect(draft?.nearbyAreas[1]!.length).toBeLessThanOrEqual(60);
    expect(draft?.faqs).toEqual([{ question: '¿Hay furgoneta?', answer: 'Sí.' }]);
    expect(draft?.seoTitle!.length).toBeLessThanOrEqual(70);
  });

  it('una ciudad no lleva nota del local más cercano; sin intro no hay borrador', () => {
    expect(
      parseAreaPageDraft('{"intro":"Hola","nearestNote":"x"}', 'city')?.nearestNote,
    ).toBeNull();
    expect(parseAreaPageDraft('{"faqs":[]}', 'city')).toBeNull();
    expect(parseAreaPageDraft('no es json', 'city')).toBeNull();
  });
});
