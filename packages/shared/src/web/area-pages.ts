import { z } from 'zod';

import { CITY_PAGE_PREFIX, citySlug } from './city-pages';

/**
 * Páginas de zona de la web del tenant (`/trasteros-en-<zona>`).
 *
 * - **Ciudad**: una por cada ciudad con locales. El tenant puede ponerle texto
 *   propio (introducción, zonas cercanas, preguntas, título para Google).
 *   Con un solo local en toda la empresa la página lleva a la portada; con un
 *   solo local en esa ciudad, a la ficha del local (que muestra el texto
 *   propio): así no hay dos páginas iguales compitiendo en Google.
 * - **Zona cercana**: un pueblo sin local («trasteros en Paterna»), con el
 *   local más cercano. Solo se indexa con texto propio suficiente: una página
 *   que solo cambia el nombre del pueblo perjudica a toda la web.
 */
export const AREA_PAGE_MIN_WORDS = 120;
/** Por debajo, el panel avisa de que la página de la ciudad no tiene texto propio. */
export const AREA_PAGE_CITY_MIN_WORDS = 60;
export const MAX_NEARBY_AREA_PAGES = 10;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const AreaPageFaqSchema = z.object({
  question: z.string().trim().min(3).max(200),
  answer: z.string().trim().min(3).max(1500),
});
export type AreaPageFaq = z.infer<typeof AreaPageFaqSchema>;

const AreaPageFields = z.object({
  name: z.string().trim().min(2).max(80),
  /** Lo que va tras `trasteros-en-`. Vacío = a partir del nombre. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Solo letras sin tildes, números y guiones')
    .max(80)
    .optional(),
  facilityIds: z.array(z.string().uuid()).max(20),
  nearestNote: optionalText(200),
  intro: optionalText(4000),
  nearbyAreas: z.array(z.string().trim().min(2).max(60)).max(15),
  faqs: z.array(AreaPageFaqSchema).max(8),
  seoTitle: optionalText(70),
  seoDescription: optionalText(200),
  isPublished: z.boolean(),
});

export const CreateAreaPageSchema = AreaPageFields.extend({
  facilityIds: AreaPageFields.shape.facilityIds.default([]),
  nearbyAreas: AreaPageFields.shape.nearbyAreas.default([]),
  faqs: AreaPageFields.shape.faqs.default([]),
  isPublished: AreaPageFields.shape.isPublished.default(true),
});
export type CreateAreaPageInput = z.infer<typeof CreateAreaPageSchema>;

/** Un campo que no se envía no cambia. */
export const UpdateAreaPageSchema = AreaPageFields.partial();
export type UpdateAreaPageInput = z.infer<typeof UpdateAreaPageSchema>;

/** Contenido publicado de una página de zona (va en la web pública). */
export interface PublicAreaPageContentDto {
  slug: string;
  name: string;
  facilityIds: string[];
  nearestNote: string | null;
  intro: string | null;
  nearbyAreas: string[];
  faqs: AreaPageFaq[];
  seoTitle: string | null;
  seoDescription: string | null;
}

export type AreaPageKind = 'city' | 'nearby';

/** A dónde lleva la dirección en vez de mostrar una página propia. */
export type AreaPageRedirect = { to: 'home' } | { to: 'facility'; publicSlug: string };

export interface ResolvedAreaPage<T> {
  slug: string;
  name: string;
  kind: AreaPageKind;
  facilities: T[];
  content: PublicAreaPageContentDto | null;
  redirect: AreaPageRedirect | null;
  /** Se muestra y se indexa (va al sitemap). */
  indexable: boolean;
}

/** Palabras de un texto (para exigir texto propio). */
export function wordCount(text: string | null | undefined): number {
  return text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/** Dirección de la página: `trasteros-en-<slug>`. */
export function areaPagePath(slug: string): string {
  return `${CITY_PAGE_PREFIX}${slug}`;
}

/** Slug de una página a partir de su nombre o del slug elegido. */
export function areaPageSlug(input: { name: string; slug?: string | null | undefined }): string {
  return input.slug?.trim() ? input.slug.trim().toLowerCase() : citySlug(input.name);
}

/**
 * Todas las páginas de zona del tenant: una por ciudad con locales y las de
 * zona cercana publicadas (con algún local que mostrar). `contents` son solo
 * las publicadas.
 */
export function resolveAreaPages<
  T extends { id: string; city: string | null; publicSlug: string | null },
>(facilities: T[], contents: PublicAreaPageContentDto[]): ResolvedAreaPage<T>[] {
  const byCity = new Map<string, { name: string; facilities: T[] }>();
  for (const f of facilities) {
    const name = f.city?.trim();
    if (!name) continue;
    const slug = citySlug(name);
    if (!slug) continue;
    const group = byCity.get(slug) ?? { name, facilities: [] };
    group.facilities.push(f);
    byCity.set(slug, group);
  }

  const cities: ResolvedAreaPage<T>[] = [...byCity.entries()].map(([slug, group]) => {
    const only = group.facilities[0];
    const redirect: AreaPageRedirect | null =
      facilities.length === 1
        ? { to: 'home' }
        : group.facilities.length === 1 && only?.publicSlug
          ? { to: 'facility', publicSlug: only.publicSlug }
          : null;
    return {
      slug,
      name: group.name,
      kind: 'city',
      facilities: group.facilities,
      content: contents.find((c) => c.slug === slug) ?? null,
      redirect,
      indexable: redirect == null,
    };
  });

  const nearby: ResolvedAreaPage<T>[] = [];
  for (const c of contents) {
    if (byCity.has(c.slug) || nearby.length >= MAX_NEARBY_AREA_PAGES) continue;
    const shown = facilities.filter((f) => c.facilityIds.includes(f.id));
    if (shown.length === 0) continue;
    nearby.push({
      slug: c.slug,
      name: c.name,
      kind: 'nearby',
      facilities: shown,
      content: c,
      redirect: null,
      indexable: wordCount(c.intro) >= AREA_PAGE_MIN_WORDS,
    });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'es');
  return [...cities.sort(byName), ...nearby.sort(byName)];
}

/** Página de la ciudad que se muestra en la ficha del local (su ciudad redirige a ella). */
export function areaPageShownOnFacility<T extends { id: string }>(
  pages: ResolvedAreaPage<T>[],
  facilityId: string,
): ResolvedAreaPage<T> | null {
  return (
    pages.find(
      (p) =>
        p.kind === 'city' &&
        p.redirect?.to === 'facility' &&
        p.facilities.some((f) => f.id === facilityId),
    ) ?? null
  );
}

/** Página de la ciudad del local, si se muestra por sí misma (para enlazarla). */
export function cityPageOfFacility<T extends { id: string }>(
  pages: ResolvedAreaPage<T>[],
  facilityId: string,
): ResolvedAreaPage<T> | null {
  return (
    pages.find(
      (p) => p.kind === 'city' && p.indexable && p.facilities.some((f) => f.id === facilityId),
    ) ?? null
  );
}

/** Página de zona en el panel: lo guardado + cómo se ve en la web. */
export interface AreaPageDto {
  id: string;
  slug: string;
  name: string;
  facilityIds: string[];
  nearestNote: string | null;
  intro: string | null;
  nearbyAreas: string[];
  faqs: AreaPageFaq[];
  seoTitle: string | null;
  seoDescription: string | null;
  isPublished: boolean;
  updatedAt: string;
}

/** Estado de cada página en la web (para el panel). */
export interface AreaPageOverviewDto {
  slug: string;
  name: string;
  kind: AreaPageKind;
  facilityNames: string[];
  /** Id de la página guardada, si tiene texto propio. */
  pageId: string | null;
  isPublished: boolean;
  redirect: AreaPageRedirect | null;
  indexable: boolean;
  introWords: number;
  /** Avisos para el panel: sin texto propio, poco texto, sin locales… */
  warnings: ('no_intro' | 'short_intro' | 'no_facilities' | 'not_published')[];
}

export interface AreaPagesSettingsDto {
  pages: AreaPageDto[];
  overview: AreaPageOverviewDto[];
  /** Con un solo local, la portada hace de página de la ciudad. */
  singleFacility: boolean;
}

/** Enlace del pie de la web a una página de zona (o a la ficha que hace de ciudad). */
export interface AreaPageLinkDto {
  name: string;
  kind: AreaPageKind;
  /** Lo que va tras la base de la web: `trasteros-en-<zona>` o el slug de la ficha. */
  path: string;
}

/** Enlaces a las páginas de zona que se ofrecen a Google (para el pie de la web). */
export function areaPageLinks<T extends { publicSlug: string | null }>(
  pages: ResolvedAreaPage<T>[],
): AreaPageLinkDto[] {
  return pages.flatMap((p) => {
    if (p.redirect?.to === 'facility') {
      return [{ name: p.name, kind: p.kind, path: p.redirect.publicSlug }];
    }
    return p.indexable ? [{ name: p.name, kind: p.kind, path: areaPagePath(p.slug) }] : [];
  });
}
