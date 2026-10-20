/**
 * sitemap.xml con el orden que exige el esquema (sitemaps.org 0.9): `loc`,
 * `lastmod`, `changefreq`, `priority` y, al final, los enlaces de idioma
 * (`xhtml:link`, hreflang). Next.js los escribe antes de `lastmod` y el
 * documento no valida.
 */
export interface SitemapUrl {
  loc: string;
  /** ISO o `YYYY-MM-DD`. */
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
  /** Idioma → URL (se añade `x-default` con la española). */
  alternates?: Record<string, string>;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemap(urls: SitemapUrl[]): string {
  const hasAlternates = urls.some((u) => u.alternates && Object.keys(u.alternates).length > 0);
  const lines = urls.map((u) => {
    const parts = [`<loc>${escapeXml(u.loc)}</loc>`];
    if (u.lastmod) parts.push(`<lastmod>${escapeXml(u.lastmod.slice(0, 10))}</lastmod>`);
    if (u.changefreq) parts.push(`<changefreq>${u.changefreq}</changefreq>`);
    if (u.priority != null) parts.push(`<priority>${u.priority.toFixed(1)}</priority>`);
    const alts = Object.entries(u.alternates ?? {});
    if (alts.length > 0) {
      const withDefault = [...alts, ...(u.alternates?.es ? [['x-default', u.alternates.es]] : [])];
      for (const [lang, href] of withDefault) {
        parts.push(
          `<xhtml:link rel="alternate" hreflang="${escapeXml(lang!)}" href="${escapeXml(href!)}"/>`,
        );
      }
    }
    return `<url>${parts.join('')}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${
      hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''
    }>`,
    ...lines,
    '</urlset>',
    '',
  ].join('\n');
}
