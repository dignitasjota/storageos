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
  const paths: { path: string; priority: string }[] = [
    { path: '/', priority: '1.0' },
    ...LANDING_SECTION_PATHS.map((p) => ({ path: `/${p}`, priority: '0.8' })),
    ...entry.facilitySlugs.map((f) => ({ path: `/${encodeURIComponent(f)}`, priority: '0.8' })),
    ...(entry.blogPostSlugs.length > 0 ? [{ path: '/blog', priority: '0.6' }] : []),
    ...entry.blogPostSlugs.map((p) => ({
      path: `/blog/${encodeURIComponent(p)}`,
      priority: '0.5',
    })),
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map(
      (p) =>
        `<url><loc>${escapeXml(`${base}${p.path}`)}</loc><lastmod>${lastmod}</lastmod><priority>${p.priority}</priority></url>`,
    ),
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
