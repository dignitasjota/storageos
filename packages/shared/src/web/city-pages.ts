/**
 * Páginas por ciudad de la web del tenant (`/trasteros-en-<ciudad>`): la
 * búsqueda más habitual es «trasteros en <ciudad>». Solo para negocios con
 * dos o más locales (con uno, sería una copia de la portada).
 */
export const CITY_PAGE_PREFIX = 'trasteros-en-';

/** `Alcalá de Henares` → `alcala-de-henares`. */
export function citySlug(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CityPage<T> {
  name: string;
  slug: string;
  facilities: T[];
}

/** Ciudades con página propia (agrupadas por slug), o [] con menos de dos locales. */
export function cityPages<T extends { city: string | null }>(facilities: T[]): CityPage<T>[] {
  if (facilities.length < 2) return [];
  const byCity = new Map<string, CityPage<T>>();
  for (const f of facilities) {
    const name = f.city?.trim();
    if (!name) continue;
    const slug = citySlug(name);
    if (!slug) continue;
    const page = byCity.get(slug) ?? { name, slug, facilities: [] };
    page.facilities.push(f);
    byCity.set(slug, page);
  }
  return [...byCity.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Ciudad de una dirección `trasteros-en-<ciudad>`, o null. */
export function cityFromPageSlug(slug: string): string | null {
  return slug.startsWith(CITY_PAGE_PREFIX) ? slug.slice(CITY_PAGE_PREFIX.length) || null : null;
}
