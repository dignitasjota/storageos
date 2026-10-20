import { LANDING_SECTION_PATHS, renderSitemap, type SitemapUrl } from '@storageos/shared';

import { tenantSeoEntry } from '../shared';

/**
 * sitemap.xml del dominio propio de un tenant: su portada, precios, contacto,
 * sus locales y su blog con las direcciones de su dominio (ver `shared.ts`).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const entry = await tenantSeoEntry(slug);
  if (!entry?.customDomain) return new Response('Not found', { status: 404 });
  const base = `https://${entry.customDomain}`;
  const lastmod = entry.updatedAt;
  const posts =
    entry.blogPosts ?? entry.blogPostSlugs.map((slug) => ({ slug, updatedAt: entry.updatedAt }));
  const latestPost = posts.reduce(
    (max, p) => (p.updatedAt > max ? p.updatedAt : max),
    entry.updatedAt,
  );
  const withEn = (path: string) => ({
    es: `${base}${path}`,
    en: `${base}/l/en${path === '/' ? '' : path}`,
  });
  const urls: SitemapUrl[] = [
    { loc: `${base}/`, lastmod, priority: 1, alternates: withEn('/') },
    ...LANDING_SECTION_PATHS.map((p) => ({
      loc: `${base}/${p}`,
      lastmod,
      priority: 0.8,
      alternates: withEn(`/${p}`),
    })),
    ...entry.facilitySlugs.map((f) => ({
      loc: `${base}/${encodeURIComponent(f)}`,
      lastmod,
      priority: 0.8,
      alternates: withEn(`/${encodeURIComponent(f)}`),
    })),
    ...(entry.citySlugs ?? []).map((c) => ({
      loc: `${base}/trasteros-en-${encodeURIComponent(c)}`,
      lastmod,
      priority: 0.8,
      alternates: withEn(`/trasteros-en-${encodeURIComponent(c)}`),
    })),
    ...(entry.promoSlugs ?? []).map((p) => ({
      loc: `${base}/promo/${encodeURIComponent(p)}`,
      lastmod,
      priority: 0.7,
    })),
    ...(posts.length > 0 ? [{ loc: `${base}/blog`, lastmod: latestPost, priority: 0.6 }] : []),
    ...posts.map((p) => ({
      loc: `${base}/blog/${encodeURIComponent(p.slug)}`,
      lastmod: p.updatedAt,
      priority: 0.5,
    })),
  ];
  const body = renderSitemap(urls);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
