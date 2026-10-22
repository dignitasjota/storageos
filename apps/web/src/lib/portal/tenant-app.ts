import type { PublicTenantBrandDto } from '@storageos/shared';

/**
 * App del portal con la marca del operador: al instalarla, el inquilino ve
 * «Trasteros García» con su color e iniciales, no la de TrasterOS.
 */

export const DEFAULT_BRAND_COLOR = '#2563EB';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidTenantSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function brandColorOf(brand: Pick<PublicTenantBrandDto, 'brandColor'> | null): string {
  const c = brand?.brandColor;
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_BRAND_COLOR;
}

/** Blanco o casi negro, el que más contraste dé sobre `hex`. */
export function textColorOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  return l > 0.45 ? '#0f172a' : '#ffffff';
}

const LEGAL_SUFFIX = /[\s,]+(s\.?\s?l\.?(\s?u\.?)?|s\.?\s?a\.?|s\.?\s?coop\.?|c\.?\s?b\.?|slne)$/i;

/** Nombre sin la forma jurídica: «Trasteros García, S.L.» → «Trasteros García». */
export function appName(tenantName: string): string {
  const clean = tenantName.trim().replace(LEGAL_SUFFIX, '').trim();
  return clean || tenantName.trim();
}

/** Nombre bajo el icono (la pantalla de inicio corta a unos 12 caracteres). */
export function appShortName(tenantName: string): string {
  const name = appName(tenantName);
  if (name.length <= 12) return name;
  const first = name.split(/\s+/)[0] ?? name;
  return first.length <= 12 ? first : `${first.slice(0, 11)}…`;
}

const MINOR_WORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'y',
  'e',
  'en',
  'of',
  'the',
  'and',
]);

/** Hasta dos iniciales: «Trasteros del Norte» → «TN». */
export function appInitials(tenantName: string): string {
  const all = appName(tenantName)
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const main = all.filter((w) => !MINOR_WORDS.has(w.toLowerCase()));
  const words = main.length > 0 ? main : all;
  const picked = words.length >= 2 ? [words[0]!, words[1]!] : [words[0] ?? 'T'];
  return (
    picked
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || 'T'
  );
}

/**
 * Versión del icono: cambia al subir otro logo, para que el móvil y la caché
 * no sigan con el anterior. Vacía sin logo subido.
 */
export function iconVersion(
  brand: Pick<PublicTenantBrandDto, 'logoUploaded' | 'logoUrl'> | null,
): string {
  if (!brand?.logoUploaded || !brand.logoUrl) return '';
  const file = brand.logoUrl.split('/').pop() ?? '';
  return file.replace(/\.[a-z]+$/i, '').slice(0, 8);
}

export const tenantManifestPath = (slug: string) => `/portal/app/${slug}/manifest`;
export const tenantIconPath = (slug: string, size: number, maskable = false, version = '') => {
  const query = [maskable ? 'maskable=1' : '', version ? `v=${version}` : ''].filter(Boolean);
  return `/portal/app/${slug}/icon/${size}${query.length ? `?${query.join('&')}` : ''}`;
};
