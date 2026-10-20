import { renderSitemap, type PublicSitemapDto, type SitemapUrl } from '@storageos/shared';

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
 * Sitemap de la plataforma: la portada, las páginas legales y las webs de
 * los tenants sin dominio propio (`/s/<tenant>`, locales, zonas, landings y
 * blog). Se regenera cada hora. Ruta propia (no `sitemap.ts`) para escribir
 * los elementos en el orden que exige el esquema.
 */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  const base = siteUrl();
  let data: PublicSitemapDto = { entries: [] };
  try {
    const res = await fetch(`${API_URL}/public/landing/sitemap`, {
      headers: internalApiHeaders(),
      next: { revalidate: 3600 },
    });
    if (res.ok) data = (await res.json()) as PublicSitemapDto;
  } catch {
    // Sin API disponible: sitemap mínimo (solo la home y las legales).
  }

  const urls: SitemapUrl[] = [
    { loc: `${base}/`, changefreq: 'weekly', priority: 1 },
    { loc: `${base}/terminos`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/privacidad`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/cookies`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/eliminar-datos`, changefreq: 'yearly', priority: 0.2 },
  ];
  for (const entry of data.entries) {
    // Con dominio propio, su web va en el sitemap de su dominio (la canónica
    // de sus páginas apunta allí).
    if (entry.customDomain) continue;
    const lastmod = entry.updatedAt;
    const tenantBase = `${base}/s/${entry.tenantSlug}`;
    const withEn = (path: string) => ({
      es: `${tenantBase}${path}`,
      en: `${tenantBase}/l/en${path}`,
    });
    urls.push({
      loc: tenantBase,
      lastmod,
      changefreq: 'daily',
      priority: 0.8,
      alternates: withEn(''),
    });
    for (const f of entry.facilitySlugs) {
      urls.push({
        loc: `${tenantBase}/${f}`,
        lastmod,
        changefreq: 'daily',
        priority: 0.7,
        alternates: withEn(`/${f}`),
      });
    }
    for (const c of entry.citySlugs ?? []) {
      urls.push({
        loc: `${tenantBase}/trasteros-en-${c}`,
        lastmod,
        changefreq: 'weekly',
        priority: 0.7,
        alternates: withEn(`/trasteros-en-${c}`),
      });
    }
    for (const p of entry.promoSlugs ?? []) {
      urls.push({
        loc: `${tenantBase}/promo/${p}`,
        lastmod,
        changefreq: 'weekly',
        priority: 0.6,
      });
    }
    const posts =
      entry.blogPosts ?? entry.blogPostSlugs.map((slug) => ({ slug, updatedAt: entry.updatedAt }));
    if (posts.length > 0) {
      urls.push({
        loc: `${tenantBase}/blog`,
        lastmod: new Date(
          Math.max(...posts.map((p) => new Date(p.updatedAt).getTime())),
        ).toISOString(),
        changefreq: 'weekly',
        priority: 0.6,
      });
      for (const p of posts) {
        urls.push({
          loc: `${tenantBase}/blog/${p.slug}`,
          lastmod: p.updatedAt,
          changefreq: 'monthly',
          priority: 0.5,
        });
      }
    }
  }
  return new Response(renderSitemap(urls), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
