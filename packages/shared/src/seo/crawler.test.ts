import { describe, expect, it } from 'vitest';

import {
  analyzeSeoCrawl,
  compareSeoCrawlIssues,
  parseSeoRobotsTxt,
  parseSeoSitemap,
  seoCrawlAlerts,
  seoCrawlDepths,
  seoCrawlDue,
  seoCrawlExcluded,
  seoCrawlInSite,
  seoCrawlLinkGraph,
  seoCrawlSettingsOf,
  seoCrawlSiteOf,
  seoIndexCrawlConfirmation,
  seoRelatedQuery,
  seoRobotsAllowed,
  SEO_CRAWLER_ROBOTS_TOKEN,
  SEO_CRAWL_DEFAULTS,
  SEO_CRAWL_ISSUES,
  SEO_CRAWL_ISSUE_TYPES,
  type SeoCrawlPageFacts,
} from './crawler';
import { normalizeSeoUrl } from './diagnostics';
import {
  SEO_DEFAULT_OPPORTUNITY_THRESHOLDS,
  SEO_DEFAULT_WEIGHTS,
  detectSeoOpportunities,
  scoreSeoOpportunity,
} from './opportunities';

const H = 'https://ejemplo.es';

/** Una página HTML que responde bien, con lo justo para no dar incidencias de contenido. */
function page(path: string, over: Partial<SeoCrawlPageFacts> = {}): SeoCrawlPageFacts {
  const url = `${H}${path}`;
  return {
    url,
    key: normalizeSeoUrl(url),
    source: 'link',
    inScope: true,
    status: 200,
    finalStatus: 200,
    finalUrl: null,
    redirectChain: [],
    error: null,
    responseMs: 120,
    isHtml: true,
    robotsBlocked: false,
    googleBlocked: false,
    title: `Trasteros en Valencia ${path}`,
    description: `Alquila un trastero en Valencia con acceso 24 horas y sin permanencia ${path}.`,
    h1: [`Trasteros ${path}`],
    canonical: url,
    noindex: false,
    nofollow: false,
    hreflang: [],
    jsonLdTypes: [],
    jsonLdInvalid: 0,
    imagesTotal: 0,
    imagesWithoutAlt: 0,
    links: [],
    inSitemap: false,
    impressions: 0,
    ...over,
  };
}
const HOME = normalizeSeoUrl(`${H}/`);
const typesOf = (issues: { type: string; url: string }[], path: string) =>
  issues
    .filter((i) => i.url === `${H}${path}`)
    .map((i) => i.type)
    .sort();

describe('robots.txt', () => {
  const robots = parseSeoRobotsTxt(`
# comentario
User-agent: *
Disallow: /area-clientes/
Disallow: /*?token=
Allow: /area-clientes/ayuda$
Sitemap: https://ejemplo.es/sitemap.xml

User-agent: Googlebot
User-agent: Bingbot
Disallow: /privado

User-agent: trasteros-seo-crawler
Disallow: /pruebas
Disallow:
`);

  it('lee grupos, reglas y mapas del sitio', () => {
    expect(robots.sitemaps).toEqual(['https://ejemplo.es/sitemap.xml']);
    expect(robots.groups).toHaveLength(3);
    expect(robots.groups[1]!.agents).toEqual(['googlebot', 'bingbot']);
  });

  it('aplica el grupo más específico y la regla más larga (permitir gana el empate)', () => {
    // Nuestro rastreador tiene grupo propio: solo bloquea /pruebas.
    expect(seoRobotsAllowed(robots, SEO_CRAWLER_ROBOTS_TOKEN, `${H}/area-clientes/x`).allowed).toBe(
      true,
    );
    expect(seoRobotsAllowed(robots, SEO_CRAWLER_ROBOTS_TOKEN, `${H}/pruebas/1`)).toEqual({
      allowed: false,
      rule: 'Disallow: /pruebas',
    });
    // Google: su grupo.
    expect(seoRobotsAllowed(robots, 'googlebot', `${H}/privado/a`).allowed).toBe(false);
    expect(seoRobotsAllowed(robots, 'googlebot', `${H}/area-clientes/x`).allowed).toBe(true);
    // Uno sin grupo propio usa «*», con comodines y `$`.
    const other = 'otro-bot';
    expect(seoRobotsAllowed(robots, other, `${H}/area-clientes/x`).allowed).toBe(false);
    expect(seoRobotsAllowed(robots, other, `${H}/area-clientes/ayuda`).allowed).toBe(true);
    expect(seoRobotsAllowed(robots, other, `${H}/area-clientes/ayuda/mas`).allowed).toBe(false);
    expect(seoRobotsAllowed(robots, other, `${H}/firma?token=abc`).allowed).toBe(false);
    expect(seoRobotsAllowed(robots, other, `${H}/precios`).allowed).toBe(true);
  });

  it('sin robots.txt todo vale', () => {
    expect(seoRobotsAllowed(null, 'x', `${H}/lo-que-sea`)).toEqual({ allowed: true, rule: null });
  });
});

describe('mapas del sitio', () => {
  it('lee las URL y si es un índice', () => {
    expect(
      parseSeoSitemap(`<?xml version="1.0"?><urlset><url><loc> https://ejemplo.es/a?x=1&amp;y=2 </loc></url>
      <url><loc><![CDATA[https://ejemplo.es/b]]></loc></url><url><loc>/relativa</loc></url></urlset>`),
    ).toEqual({ index: false, urls: ['https://ejemplo.es/a?x=1&y=2', 'https://ejemplo.es/b'] });
    expect(
      parseSeoSitemap(
        '<sitemapindex><sitemap><loc>https://ejemplo.es/s1.xml</loc></sitemap></sitemapindex>',
      ),
    ).toEqual({ index: true, urls: ['https://ejemplo.es/s1.xml'] });
  });
});

describe('alcance y ajustes', () => {
  it('el sitio de una propiedad de dominio o de prefijo con ruta', () => {
    expect(seoCrawlSiteOf('sc-domain:ejemplo.es', 'ejemplo.es')).toEqual({
      startUrl: 'https://ejemplo.es/',
      host: 'ejemplo.es',
      scheme: 'https',
      pathPrefix: '/',
    });
    const s = seoCrawlSiteOf('https://www.trasteros.pro/s/garcia/', 'trasteros.pro');
    expect(s).toMatchObject({
      startUrl: 'https://www.trasteros.pro/s/garcia/',
      pathPrefix: '/s/garcia/',
    });
    expect(seoCrawlInSite('https://trasteros.pro/s/garcia/precios', s)).toBe(true);
    expect(seoCrawlInSite('https://trasteros.pro/s/garcia', s)).toBe(true);
    expect(seoCrawlInSite('https://trasteros.pro/s/otro/precios', s)).toBe(false);
    expect(seoCrawlInSite('https://evil.es/s/garcia/', s)).toBe(false);
    expect(seoCrawlInSite('mailto:a@b.es', s)).toBe(false);
  });

  it('ajustes por defecto y dentro de su rango; rutas excluidas', () => {
    expect(seoCrawlSettingsOf(null, 'tenant')).toEqual(SEO_CRAWL_DEFAULTS.tenant);
    expect(SEO_CRAWL_DEFAULTS.platform.weeklyEnabled).toBe(true);
    expect(SEO_CRAWL_DEFAULTS.tenant.weeklyEnabled).toBe(false);
    const s = seoCrawlSettingsOf(
      { maxPages: 5000, pauseMs: 10, excludePaths: [' /blog ', '/blog', 7] },
      'tenant',
    );
    expect(s.maxPages).toBe(500);
    expect(s.pauseMs).toBe(500);
    expect(s.excludePaths).toEqual(['/blog']);
    expect(seoCrawlSettingsOf({ maxPages: 5000 }, 'platform').maxPages).toBe(2000);
    expect(seoCrawlExcluded(`${H}/blog/entrada`, ['/blog'])).toBe(true);
    expect(seoCrawlExcluded(`${H}/precios?pagina=2`, ['?pagina'])).toBe(true);
    expect(seoCrawlExcluded(`${H}/precios`, ['/blog'])).toBe(false);
  });

  it('el rastreo semanal toca el día y la hora y no repite en 6 días', () => {
    const settings = { ...SEO_CRAWL_DEFAULTS.platform };
    const now = new Date('2026-11-23T03:10:00Z');
    expect(seoCrawlDue({ settings, weekday: 1, hour: 3, lastStartedAt: null, now })).toBe(true);
    expect(seoCrawlDue({ settings, weekday: 2, hour: 3, lastStartedAt: null, now })).toBe(false);
    expect(
      seoCrawlDue({ settings, weekday: 1, hour: 3, lastStartedAt: '2026-11-20T03:00:00Z', now }),
    ).toBe(false);
    expect(
      seoCrawlDue({
        settings: SEO_CRAWL_DEFAULTS.tenant,
        weekday: 1,
        hour: 3,
        lastStartedAt: null,
        now,
      }),
    ).toBe(false);
  });
});

describe('profundidad y huérfanas', () => {
  it('recorre en anchura desde la portada (las redirecciones también llevan)', () => {
    const pages = [
      page('/', { links: [`${H}/a`, `${H}/b`] }),
      page('/a', { links: [`${H}/c`, `${H}/`] }),
      page('/b', { links: [`${H}/c`] }),
      page('/c', { links: [`${H}/vieja`] }),
      page('/vieja', {
        status: 301,
        finalStatus: 200,
        finalUrl: `${H}/nueva`,
        redirectChain: [`${H}/nueva`],
      }),
      page('/nueva'),
      page('/sola', { inSitemap: true }),
    ];
    const depth = seoCrawlDepths(HOME, seoCrawlLinkGraph(pages));
    expect(depth.get(normalizeSeoUrl(`${H}/a`))).toBe(1);
    expect(depth.get(normalizeSeoUrl(`${H}/c`))).toBe(2);
    expect(depth.get(normalizeSeoUrl(`${H}/nueva`))).toBe(4);
    expect(depth.has(normalizeSeoUrl(`${H}/sola`))).toBe(false);

    const a = analyzeSeoCrawl({ pages, homeKey: HOME, sitemapFound: true });
    expect(a.depth.get(normalizeSeoUrl(`${H}/sola`))).toBeNull();
    expect(typesOf(a.issues, '/sola')).toContain('orphan_page');
    expect(typesOf(a.issues, '/nueva')).toEqual(['deep_page']);
    expect(typesOf(a.issues, '/vieja')).toEqual(['redirected_link']);
    expect(a.inlinks.get(normalizeSeoUrl(`${H}/c`))).toEqual([`${H}/a`, `${H}/b`]);
    // La portada no es huérfana aunque nadie la enlace.
    expect(typesOf(a.issues, '/')).toEqual([]);
  });

  it('huérfana por tener impresiones (y alta si es una URL objetivo)', () => {
    const pages = [page('/', {}), page('/objetivo', { impressions: 40, source: 'gsc' })];
    const key = normalizeSeoUrl(`${H}/objetivo`);
    const a = analyzeSeoCrawl({
      pages,
      homeKey: HOME,
      sitemapFound: true,
      targetKeys: new Set([key]),
    });
    const orphan = a.issues.find((i) => i.type === 'orphan_page')!;
    expect(orphan.severity).toBe('high');
    expect(orphan.detail).toContain('40 impresiones');
  });
});

describe('análisis de las páginas', () => {
  it('título, descripción, h1, canónica, robots, idiomas, datos estructurados e imágenes', () => {
    const pages = [
      page('/', {
        links: [`${H}/a`, `${H}/b`, `${H}/c`, `${H}/d`, `${H}/e`, `${H}/rota`, `${H}/caida`],
        hreflang: [
          { lang: 'es', href: `${H}/` },
          { lang: 'en', href: `${H}/en` },
          { lang: 'zz-ZZZZZ', href: `${H}/x` },
        ],
      }),
      page('/en', { hreflang: [{ lang: 'en', href: `${H}/en` }] }),
      page('/a', {
        title: null,
        description: 'corta',
        h1: [],
        canonical: null,
        imagesTotal: 4,
        imagesWithoutAlt: 3,
        jsonLdInvalid: 1,
      }),
      page('/b', {
        title: 'Un título demasiado largo para lo que Google enseña en sus resultados de búsqueda',
        h1: ['Uno', 'Dos'],
        canonical: `${H}/a`,
      }),
      page('/c', { title: 'Corto', canonical: 'http://www.ejemplo.es/c/', nofollow: true }),
      page('/d', {
        title: 'Repetido igual título',
        description: 'Desc repetida para las dos páginas iguales, con más de cincuenta.',
      }),
      page('/e', {
        title: 'Repetido igual título',
        description: 'Desc repetida para las dos páginas iguales, con más de cincuenta.',
        canonical: `${H}/caida`,
      }),
      page('/rota', { status: 404, finalStatus: 404, isHtml: false }),
      page('/caida', { status: null, finalStatus: null, error: 'timeout', isHtml: false }),
      page('/noindex', { noindex: true, inSitemap: true, links: [`${H}/`] }),
    ];
    const a = analyzeSeoCrawl({ pages, homeKey: HOME, sitemapFound: true });
    expect(typesOf(a.issues, '/a')).toEqual([
      'canonical_missing',
      'description_too_short',
      'h1_missing',
      'images_without_alt',
      'structured_data_invalid',
      'title_missing',
    ]);
    expect(typesOf(a.issues, '/b')).toEqual(['canonical_other', 'h1_multiple', 'title_too_long']);
    expect(typesOf(a.issues, '/c')).toEqual(['canonical_variant', 'nofollow', 'title_too_short']);
    expect(typesOf(a.issues, '/d')).toEqual(['description_duplicate', 'title_duplicate']);
    expect(typesOf(a.issues, '/e')).toEqual([
      'canonical_error',
      'canonical_other',
      'description_duplicate',
      'title_duplicate',
    ]);
    expect(typesOf(a.issues, '/rota')).toEqual(['broken_link', 'http_error']);
    expect(typesOf(a.issues, '/caida')).toEqual(['broken_link', 'fetch_failed']);
    // Con «noindex» en el mapa del sitio: una sola incidencia (alta) y sin las de contenido.
    expect(typesOf(a.issues, '/noindex')).toEqual(['sitemap_noindex']);
    const hreflang = a.issues.find((i) => i.type === 'hreflang_invalid' && i.url === `${H}/`)!;
    expect(hreflang.detail).toContain('zz-ZZZZZ');
    expect(hreflang.detail).toContain('sin enlace de vuelta');
    const broken = a.issues.find((i) => i.type === 'broken_link' && i.url === `${H}/rota`)!;
    expect(broken.severity).toBe('high');
    expect(broken.data.sources).toEqual([`${H}/`]);
  });

  it('la portada con «noindex» o con error sube a gravedad alta', () => {
    const a = analyzeSeoCrawl({
      pages: [page('/', { noindex: true })],
      homeKey: HOME,
      sitemapFound: true,
    });
    expect(a.issues.find((i) => i.type === 'noindex')!.severity).toBe('high');
    const b = analyzeSeoCrawl({
      pages: [page('/', { status: null, error: 'timeout', isHtml: false })],
      homeKey: HOME,
      sitemapFound: true,
    });
    expect(b.issues.find((i) => i.type === 'fetch_failed')!.severity).toBe('high');
  });

  it('mapa del sitio, cadenas de redirección, robots y lo que no se alcanzó', () => {
    const pages = [
      page('/', { links: [`${H}/privado`] }),
      page('/s-error', {
        inSitemap: true,
        status: 500,
        finalStatus: 500,
        isHtml: false,
        source: 'sitemap',
      }),
      page('/s-redir', {
        inSitemap: true,
        status: 301,
        finalStatus: 200,
        finalUrl: `${H}/final`,
        redirectChain: [`${H}/medio`, `${H}/final`],
        source: 'sitemap',
      }),
      page('/privado', {
        status: null,
        isHtml: false,
        robotsBlocked: true,
        googleBlocked: true,
        inSitemap: true,
      }),
      page('/lenta', { responseMs: 4500, links: [] }),
    ];
    const a = analyzeSeoCrawl({
      pages,
      homeKey: HOME,
      sitemapFound: false,
      sitemapErrors: [{ url: `${H}/sitemap-2.xml`, error: 'responde 404' }],
      unreached: [{ url: `${H}/olvidada`, impressions: 25 }],
    });
    expect(typesOf(a.issues, '/s-error')).toEqual(['http_error', 'sitemap_error']);
    expect(typesOf(a.issues, '/s-redir')).toEqual(['redirect_chain', 'sitemap_redirect']);
    expect(typesOf(a.issues, '/privado')).toEqual(['robots_blocked', 'sitemap_blocked']);
    expect(typesOf(a.issues, '/lenta')).toEqual(['slow_response']);
    expect(typesOf(a.issues, '/')).toEqual(['sitemap_missing']);
    expect(typesOf(a.issues, '/sitemap-2.xml')).toEqual(['sitemap_unreachable']);
    expect(typesOf(a.issues, '/olvidada')).toEqual(['not_reached']);
    // Cada tipo tiene su texto de «qué pasa» y «qué hacer».
    for (const t of SEO_CRAWL_ISSUE_TYPES) {
      expect(SEO_CRAWL_ISSUES[t].what.length).toBeGreaterThan(20);
      expect(SEO_CRAWL_ISSUES[t].how.length).toBeGreaterThan(20);
    }
  });

  it('compara con el rastreo anterior', () => {
    expect(compareSeoCrawlIssues(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd', 'e']))).toEqual({
      newIssues: 2,
      resolvedIssues: 1,
      continuingIssues: 2,
    });
  });
});

describe('integración', () => {
  const facts = {
    url: `${H}/area-clientes`,
    crawledAt: '2026-11-25T10:00:00.000Z',
    status: 200,
    finalStatus: 200,
    finalUrl: null,
    error: null,
    noindex: false,
    robotsBlocked: false,
    googleBlocked: false,
    canonical: null,
    inSitemap: false,
    inlinks: 2,
  };

  it('confirma el motivo de un hallazgo de indexación', () => {
    expect(seoIndexCrawlConfirmation('private', facts)).toMatchObject({ confirmed: true });
    expect(seoIndexCrawlConfirmation('private', facts).text).toContain('no tiene «noindex»');
    expect(seoIndexCrawlConfirmation('private', { ...facts, noindex: true }).confirmed).toBe(false);
    expect(seoIndexCrawlConfirmation('login', { ...facts, googleBlocked: true }).text).toContain(
      'no puede ver',
    );
    expect(seoIndexCrawlConfirmation('duplicate', facts).text).toContain('no declara canónica');
    expect(
      seoIndexCrawlConfirmation('params', { ...facts, canonical: `${H}/buena` }).confirmed,
    ).toBe(false);
    expect(seoIndexCrawlConfirmation('redirect_domain', facts)).toMatchObject({ confirmed: true });
    expect(
      seoIndexCrawlConfirmation('redirect_domain', { ...facts, status: 301, finalUrl: `${H}/` })
        .text,
    ).toContain('correcto');
    expect(seoIndexCrawlConfirmation('private', { ...facts, status: 404 }).confirmed).toBe(false);
  });

  it('búsquedas relacionadas', () => {
    expect(seoRelatedQuery('trasteros valencia', 'alquiler trasteros en valencia')).toBe(true);
    expect(seoRelatedQuery('trasteros valencia', 'trasteros madrid')).toBe(false);
    expect(seoRelatedQuery('guardamuebles', 'guardamuebles baratos')).toBe(true);
    expect(seoRelatedQuery('de la', 'lo que sea')).toBe(false);
  });

  it('alertas: errores nuevos y la portada o una URL objetivo caída', () => {
    const alerts = seoCrawlAlerts({
      crawlId: 'c1',
      finishedAt: '2026-11-25T10:00:00.000Z',
      newErrors: [{ url: `${H}/rota`, status: 404, error: null }],
      critical: [
        { url: `${H}/`, urlKey: HOME, home: true, keywords: [], problem: 'noindex', status: 200 },
        {
          url: `${H}/precios`,
          urlKey: 'ejemplo.es/precios',
          home: false,
          keywords: ['precio trastero'],
          problem: 'error',
          status: 500,
        },
      ],
    });
    expect(alerts.map((a) => [a.type, a.key, a.severity])).toEqual([
      ['crawl_errors', 'crawl_errors|c1', 'medium'],
      ['crawl_critical', `crawl_critical|${HOME}`, 'high'],
      ['crawl_critical', 'crawl_critical|ejemplo.es/precios', 'high'],
    ]);
    expect(alerts[2]!.title).toContain('no responde');
  });

  it('oportunidad «pocos enlaces internos» con la puntuación de siempre', () => {
    const row = {
      query: 'trasteros valencia',
      clicks: 20,
      impressions: 600,
      position: 8,
      previous: null,
    };
    const base = {
      domain: 'ejemplo.es',
      brandTerms: [],
      weights: { ...SEO_DEFAULT_WEIGHTS },
      thresholds: { ...SEO_DEFAULT_OPPORTUNITY_THRESHOLDS },
      period: {
        from: '2026-10-01',
        to: '2026-10-28',
        previousFrom: '2026-09-03',
        previousTo: '2026-09-30',
        comparable: false,
      },
      queries: [row],
      keywords: [
        {
          keyword: 'trasteros valencia',
          inCatalog: true,
          intent: null,
          priority: 1,
          targetUrl: '/valencia',
          metrics: null,
        },
      ],
      sistrixMetricsAvailable: false,
      sistrixOpportunities: [],
      keywordGaps: [],
    };
    const link = {
      keyword: 'trasteros valencia',
      targetUrl: `${H}/valencia`,
      inlinks: 1,
      crawled: true,
      crawledAt: '2026-11-25T10:00:00.000Z',
      suggestions: [
        { url: `${H}/blog/guia`, impressions: 120, query: 'trasteros en valencia baratos' },
      ],
    };
    const found = detectSeoOpportunities({ ...base, internalLinks: [link] });
    const opp = found.find((o) => o.type === 'internal_links')!;
    expect(opp.metrics.internalLinks).toMatchObject({ inlinks: 1, min: 3 });
    expect(opp.reason).toContain('solo 1 página de tu web la enlaza');
    // Misma fórmula: los mismos datos de Google puntúan igual que «cerca del top 3».
    const near = found.find((o) => o.type === 'near_top3')!;
    expect(opp.score).toBe(near.score);
    expect(opp.score).toBe(
      scoreSeoOpportunity({
        impressions: 600,
        clicks: 20,
        volume: null,
        gain: null,
        position: 8,
        ctr: near.metrics.gsc!.ctr,
        intent: near.metrics.intent?.value ?? null,
        priority: 1,
        positionDiff: null,
        impressionsPct: null,
        competition: null,
        hasGsc: true,
        hasSistrix: false,
        comparable: false,
      }).score,
    );
    // Con suficientes enlaces, no sale; sin el dato del rastreo, nada cambia.
    expect(
      detectSeoOpportunities({ ...base, internalLinks: [{ ...link, inlinks: 3 }] }).some(
        (o) => o.type === 'internal_links',
      ),
    ).toBe(false);
    expect(detectSeoOpportunities(base).map((o) => o.type)).toEqual(
      found.filter((o) => o.type !== 'internal_links').map((o) => o.type),
    );
  });
});
