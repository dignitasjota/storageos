import { renderSitemap, type SitemapUrl } from '@storageos/shared';

import { fetchPlatformBlogPosts } from '@/lib/marketing/blog';
import { FEATURE_PAGES, SOLUTION_PAGES, marketingPageHref } from '@/lib/marketing/pages';

/** URL pública del sitio (para URLs absolutas en el sitemap). */
function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * Sitemap de la plataforma: la portada, las páginas legales y las herramientas
 * públicas. Las webs de los negocios no van aquí (SEO web D4). Se regenera cada hora. Ruta propia (no `sitemap.ts`) para escribir
 * los elementos en el orden que exige el esquema.
 */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  const base = siteUrl();
  const blogPosts = await fetchPlatformBlogPosts();
  const urls: SitemapUrl[] = [
    { loc: `${base}/`, changefreq: 'weekly', priority: 1 },
    { loc: `${base}/precios`, changefreq: 'weekly', priority: 0.9 },
    { loc: `${base}/funcionalidades`, changefreq: 'monthly', priority: 0.8 },
    ...FEATURE_PAGES.map((p) => ({
      loc: `${base}${marketingPageHref(p)}`,
      changefreq: 'monthly' as const,
      priority: 0.8,
    })),
    { loc: `${base}/soluciones`, changefreq: 'monthly', priority: 0.7 },
    ...SOLUTION_PAGES.map((p) => ({
      loc: `${base}${marketingPageHref(p)}`,
      changefreq: 'monthly' as const,
      priority: 0.8,
    })),
    { loc: `${base}/calculadora-rentabilidad-trasteros`, changefreq: 'monthly', priority: 0.7 },
    { loc: `${base}/blog`, changefreq: 'weekly', priority: 0.7 },
    ...blogPosts.map((p) => ({
      loc: `${base}/blog/${p.slug}`,
      lastmod: p.publishedAt,
      changefreq: 'monthly' as const,
      priority: 0.6,
    })),
    { loc: `${base}/terminos`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/privacidad`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/cookies`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/eliminar-datos`, changefreq: 'yearly', priority: 0.2 },
    { loc: `${base}/declaracion-responsable`, changefreq: 'yearly', priority: 0.2 },
  ];
  // Ningún negocio va en el sitemap de la plataforma (SEO web D4): `/s/<slug>`
  // redirige 308 a su dominio propio o a su subdominio, que no se indexa. Con
  // dominio propio, su web va en el sitemap de su dominio (`tenant-seo`).
  return new Response(renderSitemap(urls), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
