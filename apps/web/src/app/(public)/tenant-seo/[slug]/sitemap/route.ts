import { LANDING_SECTION_PATHS } from '@storageos/shared';

import { tenantSeoEntry } from '../shared';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  const lastmod = entry.updatedAt.slice(0, 10);
  const posts =
    entry.blogPosts ?? entry.blogPostSlugs.map((slug) => ({ slug, updatedAt: entry.updatedAt }));
  const latestPost = posts.reduce(
    (max, p) => (p.updatedAt > max ? p.updatedAt : max),
    entry.updatedAt,
  );
  const paths: { path: string; priority: string; lastmod?: string; en?: string }[] = [
    { path: '/', priority: '1.0', en: '/l/en' },
    ...LANDING_SECTION_PATHS.map((p) => ({
      path: `/${p}`,
      priority: '0.8',
      en: `/l/en/${p}`,
    })),
    ...entry.facilitySlugs.map((f) => ({
      path: `/${encodeURIComponent(f)}`,
      priority: '0.8',
      en: `/l/en/${encodeURIComponent(f)}`,
    })),
    ...(entry.promoSlugs ?? []).map((p) => ({
      path: `/promo/${encodeURIComponent(p)}`,
      priority: '0.7',
    })),
    ...(posts.length > 0
      ? [{ path: '/blog', priority: '0.6', lastmod: latestPost.slice(0, 10) }]
      : []),
    ...posts.map((p) => ({
      path: `/blog/${encodeURIComponent(p.slug)}`,
      priority: '0.5',
      lastmod: p.updatedAt.slice(0, 10),
    })),
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...paths.map((p) => {
      const loc = escapeXml(`${base}${p.path}`);
      // Versión en inglés de la misma página (hreflang).
      const alt = p.en
        ? `<xhtml:link rel="alternate" hreflang="es" href="${loc}"/><xhtml:link rel="alternate" hreflang="en" href="${escapeXml(`${base}${p.en}`)}"/>`
        : '';
      return `<url><loc>${loc}</loc>${alt}<lastmod>${p.lastmod ?? lastmod}</lastmod><priority>${p.priority}</priority></url>`;
    }),
    '</urlset>',
    '',
  ].join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
