import type { PublicSitemapDto } from '@storageos/shared';
import type { MetadataRoute } from 'next';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

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
    const res = await fetch(`${API_URL}/public/landing/sitemap`, {
      headers: internalApiHeaders(),
      next: { revalidate: 3600 },
    });
    if (res.ok) data = (await res.json()) as PublicSitemapDto;
  } catch {
    // Sin API disponible: sitemap mínimo (solo la home).
  }

  const urls: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${base}/terminos`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/privacidad`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/cookies`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/eliminar-datos`, changeFrequency: 'yearly', priority: 0.2 },
  ];
  for (const entry of data.entries) {
    // Con dominio propio, su web va en el sitemap de su dominio (la canónica
    // de sus páginas apunta allí).
    if (entry.customDomain) continue;
    const lastModified = new Date(entry.updatedAt);
    const tenantBase = `${base}/s/${entry.tenantSlug}`;
    urls.push({
      url: tenantBase,
      lastModified,
      changeFrequency: 'daily',
      priority: 0.8,
      alternates: { languages: { es: tenantBase, en: `${tenantBase}/l/en` } },
    });
    for (const f of entry.facilitySlugs) {
      urls.push({
        url: `${tenantBase}/${f}`,
        lastModified,
        changeFrequency: 'daily',
        priority: 0.7,
        alternates: { languages: { es: `${tenantBase}/${f}`, en: `${tenantBase}/l/en/${f}` } },
      });
    }
    for (const p of entry.promoSlugs ?? []) {
      urls.push({
        url: `${tenantBase}/promo/${p}`,
        lastModified,
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }
    const posts =
      entry.blogPosts ?? entry.blogPostSlugs.map((slug) => ({ slug, updatedAt: entry.updatedAt }));
    if (posts.length > 0) {
      urls.push({
        url: `${tenantBase}/blog`,
        lastModified: new Date(Math.max(...posts.map((p) => new Date(p.updatedAt).getTime()))),
        changeFrequency: 'weekly',
        priority: 0.6,
      });
      for (const p of posts) {
        urls.push({
          url: `${tenantBase}/blog/${p.slug}`,
          lastModified: new Date(p.updatedAt),
          changeFrequency: 'monthly',
          priority: 0.5,
        });
      }
    }
  }
  return urls;
}
