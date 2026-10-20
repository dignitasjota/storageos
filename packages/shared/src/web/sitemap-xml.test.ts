import { describe, expect, it } from 'vitest';

import { renderSitemap } from './sitemap-xml';

describe('sitemap.xml', () => {
  it('pone los enlaces de idioma después de lastmod, changefreq y priority', () => {
    const xml = renderSitemap([
      {
        loc: 'https://x.es/',
        lastmod: '2026-10-20T10:00:00.000Z',
        changefreq: 'daily',
        priority: 1,
        alternates: { es: 'https://x.es/', en: 'https://x.es/l/en' },
      },
    ]);
    const url = xml.split('\n').find((l) => l.startsWith('<url>'))!;
    expect(url.indexOf('<lastmod>2026-10-20</lastmod>')).toBeGreaterThan(url.indexOf('<loc>'));
    expect(url.indexOf('<priority>1.0</priority>')).toBeLessThan(url.indexOf('<xhtml:link'));
    expect(url).toContain('hreflang="x-default" href="https://x.es/"');
    expect(xml).toContain('xmlns:xhtml=');
  });

  it('escapa las URLs y no declara xhtml si no hay idiomas', () => {
    const xml = renderSitemap([{ loc: 'https://x.es/a?b=1&c=2' }]);
    expect(xml).toContain('<loc>https://x.es/a?b=1&amp;c=2</loc>');
    expect(xml).not.toContain('xmlns:xhtml');
  });
});
