import type { PublicSitemapDto } from '@storageos/shared';
import type { MetadataRoute } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** URL pública del sitio (para URLs absolutas en el sitemap). */
function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * Sitemap dinámico: incluye las landings públicas (`/s/<tenant>` y
 * `/s/<tenant>/<local>`) de los tenants activos. Se regenera cada hora.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  let data: PublicSitemapDto = { entries: [] };
  try {
    const res = await fetch(`${API_URL}/public/landing/sitemap`, { next: { revalidate: 3600 } });
    if (res.ok) data = (await res.json()) as PublicSitemapDto;
  } catch {
    // Sin API disponible: sitemap mínimo (solo la home).
  }

  const urls: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${base}/terminos`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/privacidad`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/cookies`, changeFrequency: 'yearly', priority: 0.3 },
  ];
  for (const entry of data.entries) {
    const lastModified = new Date(entry.updatedAt);
    urls.push({
      url: `${base}/s/${entry.tenantSlug}`,
      lastModified,
      changeFrequency: 'daily',
      priority: 0.8,
    });
    for (const f of entry.facilitySlugs) {
      urls.push({
        url: `${base}/s/${entry.tenantSlug}/${f}`,
        lastModified,
        changeFrequency: 'daily',
        priority: 0.7,
      });
    }
  }
  return urls;
}
