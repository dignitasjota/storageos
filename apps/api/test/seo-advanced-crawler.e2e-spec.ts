import http from 'node:http';

import { hash as argonHash } from '@node-rs/argon2';
import { SEO_CRAWLER_USER_AGENT, shiftDate } from '@storageos/shared';
import request from 'supertest';

import { SeoCrawlFetcher } from '../src/modules/seo-advanced/crawler/seo-crawl-fetcher';
import { SeoCrawlerService } from '../src/modules/seo-advanced/crawler/seo-crawler.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

const SUPER_EMAIL = 'seo-crawl-super@storageos.local';
const SUPPORT_EMAIL = 'seo-crawl-support@storageos.local';
const PREFIX = 'E2E rastreo ';
const HOST = 'e2e-rastreo-plataforma.es';
const P = `https://${HOST}`;
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/** Una página HTML correcta (título y descripción de buen tamaño, H1 y canónica). */
function doc(
  path: string,
  o: {
    title?: string | null;
    description?: string | null;
    h1?: string | null;
    links?: string[];
    robots?: string;
    extra?: string;
  } = {},
): string {
  const title = o.title === undefined ? `Página ${path} de trasteros en Valencia` : o.title;
  const description =
    o.description === undefined
      ? `Todo sobre ${path}: trasteros en Valencia con acceso 24 horas y sin permanencia.`
      : o.description;
  const h1 = o.h1 === undefined ? `Trasteros ${path}` : o.h1;
  return `<!doctype html><html lang="es"><head>
${title !== null ? `<title>${title}</title>` : ''}
${description !== null ? `<meta name="description" content="${description}">` : ''}
${o.robots ? `<meta name="robots" content="${o.robots}">` : ''}
<link rel="canonical" href="${P}${path}">
</head><body>${h1 !== null ? `<h1>${h1}</h1>` : ''}
${(o.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join('\n')}
${o.extra ?? ''}
</body></html>`;
}

/** Espera a que no queden descargas de Search Console del tenant. */
async function waitIdle(tenantId: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const n = await withAdminDb((db) =>
      db.seoSyncRun.count({ where: { tenantId, status: { in: ['queued', 'running'] } } }),
    );
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('las descargas no terminaron');
}

/** Espera a que un rastreo termine (o lo que se pida). */
async function waitCrawl(
  id: string,
  statuses: string[] = ['done', 'failed', 'cancelled'],
): Promise<{ status: string; error: string | null }> {
  for (let i = 0; i < 240; i++) {
    const c = await withAdminDb((db) =>
      db.seoCrawl.findUnique({ where: { id }, select: { status: true, error: true } }),
    );
    if (c && statuses.includes(c.status)) return c;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('el rastreo no terminó');
}

describe('SEO Avanzado: rastreador (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let crawler: SeoCrawlerService;
  let superToken: string;
  let supportToken: string;
  const http_ = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  const tenantIds: string[] = [];
  let owner: VerifiedUser;
  let other: VerifiedUser;
  let tenantProject = '';
  let tenantHost = '';
  let platformProject = '';
  let platformDomain = '';
  /** v1: el primer rastreo; v2: /rota funciona y /precios pierde su H1. */
  let version = 1;
  const requests: { host: string; path: string; ua: string }[] = [];
  const a = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const b = () => ({ Authorization: `Bearer ${other.accessToken}` });

  /** El sitio simulado de la plataforma (y uno mínimo para cualquier otro host). */
  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^www\./, '');
    const path = (req.url ?? '/').replace(/\?.*$/, '');
    requests.push({ host, path, ua: String(req.headers['user-agent'] ?? '') });
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const redirect = (to: string) => {
      res.writeHead(301, { location: to });
      res.end();
    };
    if (host !== HOST) {
      // Web del tenant: sin robots.txt ni mapa del sitio.
      if (path === '/') return html(200, doc('/', { links: ['/a'] }));
      if (path === '/a') return html(200, doc('/a', { links: ['/'] }));
      return html(404, 'no');
    }
    switch (path) {
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`User-agent: *\nDisallow: /privado\nSitemap: ${P}/sitemap.xml\n`);
        return;
      case '/sitemap.xml':
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<sitemapindex><sitemap><loc>${P}/sitemap-1.xml</loc></sitemap><sitemap><loc>${P}/sitemap-2.xml</loc></sitemap></sitemapindex>`,
        );
        return;
      case '/sitemap-1.xml':
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<urlset>${[
            '/',
            '/precios',
            '/huerfana',
            '/sitemap-roto',
            '/sitemap-redirige',
            '/noindex-sitemap',
          ]
            .map((u) => `<url><loc>${P}${u}</loc></url>`)
            .join('')}</urlset>`,
        );
        return;
      case '/':
        return html(
          200,
          doc('/', {
            title: 'Trasteros en Valencia · Plataforma E2E',
            links: [
              '/precios',
              '/blog',
              '/rota',
              '/vieja',
              '/privado/zona',
              'https://facebook.com/e2e',
            ],
            extra: '<script type="application/ld+json">{"@type":"Organization"}</script>',
          }),
        );
      case '/precios':
        return html(200, doc('/precios', { h1: version === 1 ? 'Precios' : null, links: ['/'] }));
      case '/blog':
        return html(
          200,
          doc('/blog', { title: 'Blog de trasteros en Valencia', links: ['/blog/entrada', '/'] }),
        );
      case '/blog/entrada':
        return html(
          200,
          doc('/blog/entrada', {
            title: 'Blog de trasteros en Valencia',
            description: null,
            h1: null,
            links: ['/blog/nivel3'],
            extra: '<img src="/foto.jpg">',
          }),
        );
      case '/blog/nivel3':
        return html(200, doc('/blog/nivel3', { links: ['/blog/nivel4'] }));
      case '/blog/nivel4':
        return html(200, doc('/blog/nivel4'));
      case '/rota':
        return version === 1 ? html(404, 'no existe') : html(200, doc('/rota', { links: ['/'] }));
      case '/vieja':
      case '/sitemap-redirige':
        return redirect(`${P}/precios`);
      case '/huerfana':
      case '/con-impresiones':
      case '/portal':
        return html(200, doc(path));
      case '/noindex-sitemap':
        return html(200, doc(path, { robots: 'noindex' }));
      default:
        return html(404, 'no existe');
    }
  }

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      const ids = (
        await db.seoProject.findMany({
          where: { tenantId: null, name: { startsWith: PREFIX } },
          select: { id: true },
        })
      ).map((p) => p.id);
      for (const id of ids) {
        await db.superAdminNotification.deleteMany({
          where: { link: { startsWith: `/admin/seo/${id}` } },
        });
      }
      await db.seoProject.deleteMany({ where: { id: { in: ids } } });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  async function tenantSetup(u: VerifiedUser): Promise<{ projectId: string; host: string }> {
    await setTenantFeatureOverride(u.slug, 'seo_advanced', true);
    const host = `web.${u.slug}.es`;
    await setVerifiedCustomDomain(u.slug, host);
    const res = await http_()
      .post('/seo-advanced/project')
      .set({ Authorization: `Bearer ${u.accessToken}` })
      .send({});
    expect(res.status).toBe(201);
    const projectId = res.body.id as string;
    await withAdminDb(async (db) => {
      const found = await db.seoProjectDomain.findFirst({ where: { projectId, role: 'primary' } });
      if (!found) {
        await db.seoProjectDomain.create({
          data: {
            tenantId: u.tenantId,
            projectId,
            domain: host,
            role: 'primary',
            gscProperty: `sc-domain:${host}`,
          },
        });
      }
    });
    await waitIdle(u.tenantId);
    const d = await withAdminDb((db) =>
      db.seoProjectDomain.findFirstOrThrow({ where: { projectId, role: 'primary' } }),
    );
    return { projectId, host: d.domain };
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Rastreo', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Rastreo', role: 'support' },
      });
    });
    server = http.createServer(handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;

    app = await createTestApp();
    crawler = app.get(SeoCrawlerService);
    // Todas las peticiones van al servidor simulado: nunca a una web real.
    app.get(SeoCrawlFetcher).useTestRouting({
      port,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    owner = await registerVerifiedUser(app, 'seocrawla');
    other = await registerVerifiedUser(app, 'seocrawlb');
    tenantIds.push(owner.tenantId, other.tenantId);
    const t = await tenantSetup(owner);
    tenantProject = t.projectId;
    tenantHost = t.host;
    await tenantSetup(other);

    // Proyecto de la plataforma con páginas en Search Console.
    const created = await http_()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'national' });
    expect(created.status).toBe(201);
    platformProject = created.body.id;
    platformDomain = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: {
            projectId: platformProject,
            domain: HOST,
            role: 'primary',
            gscProperty: `sc-domain:${HOST}`,
            dataUntil: asDate(TODAY),
          },
        }),
      )
    ).id;
    const rows: object[] = [];
    const metric = (
      grain: string,
      date: string,
      page: string,
      query: string,
      impressions: number,
    ) =>
      rows.push({
        tenantId: null,
        domainId: platformDomain,
        grain,
        date: asDate(date),
        query,
        page,
        device: '',
        country: '',
        clicks: 1,
        impressions,
        ctr: 0.05,
        position: 8,
      });
    for (let d = shiftDate(TODAY, -6); d <= TODAY; d = shiftDate(d, 1)) {
      metric('page', d, `${P}/`, '', 100);
      metric('page', d, `${P}/con-impresiones`, '', 12);
      metric('page', d, `${P}/portal`, '', 9);
      metric('query_page', d, `${P}/blog`, 'precio trastero valencia', 30);
      metric('query_page', d, `${P}/`, 'precio trastero valencia', 50);
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );
    // Palabras seguidas: la URL objetivo de una tiene pocos enlaces y la de otra, «noindex».
    const kw = await http_()
      .post(`/admin/seo/projects/${platformProject}/keywords`)
      .set(asSuper())
      .send({ keywords: ['precio trastero', 'trasteros baratos'], priority: 1 });
    expect(kw.status).toBe(201);
    await withAdminDb(async (db) => {
      const list = await db.seoProjectKeyword.findMany({
        where: { projectId: platformProject },
        include: { keyword: true },
      });
      for (const k of list) {
        await db.seoProjectKeyword.update({
          where: { id: k.id },
          data: {
            isActive: true,
            priority: 1,
            targetUrl: k.keyword.keyword === 'precio trastero' ? '/precios' : '/noindex-sitemap',
          },
        });
      }
    });
    // Hallazgos de indexación (la página privada /portal tiene impresiones).
    const diag = await http_()
      .post(`/admin/seo/projects/${platformProject}/diagnostics/recalculate`)
      .set(asSuper());
    expect([200, 201]).toContain(diag.status);
  });

  afterAll(async () => {
    app.get(SeoCrawlFetcher).useTestRouting(null);
    await app.close();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  let firstCrawl = '';

  it('rastrea la web: respeta robots.txt, lee los mapas del sitio y saca cada tipo de incidencia', async () => {
    const start = await http_().post(`/admin/seo/projects/${platformProject}/crawl`).set(asSuper());
    expect(start.status).toBe(200);
    expect(start.body.alreadyRunning).toBe(false);
    firstCrawl = start.body.crawl.id;
    expect(await waitCrawl(firstCrawl)).toMatchObject({ status: 'done', error: null });

    // robots.txt: no se pide lo bloqueado y se dice qué bloquea.
    const own = requests.filter((r) => r.host === HOST);
    expect(own.some((r) => r.path.startsWith('/privado'))).toBe(false);
    expect(own.every((r) => r.ua === SEO_CRAWLER_USER_AGENT)).toBe(true);

    const ov = await http_().get(`/admin/seo/projects/${platformProject}/crawl`).set(asSuper());
    expect(ov.status).toBe(200);
    expect(ov.body.userAgent).toBe(SEO_CRAWLER_USER_AGENT);
    expect(ov.body.live).toBeNull();
    const last = ov.body.last;
    expect(last).toMatchObject({
      id: firstCrawl,
      status: 'done',
      trigger: 'manual',
      stopReason: null,
    });
    expect(last.robots).toMatchObject({
      found: true,
      blockedCount: 1,
      blocked: [`${P}/privado/zona`],
    });
    expect(last.robots.rules).toEqual(['Disallow: /privado']);
    expect(last.sitemaps.urls).toEqual([`${P}/sitemap.xml`, `${P}/sitemap-1.xml`]);
    expect(last.sitemaps.errors).toEqual([{ url: `${P}/sitemap-2.xml`, error: 'responde 404' }]);
    expect(last.summary.newIssues).toBeGreaterThan(10);
    expect(last.errors).toBe(2);
    // La plataforma: rastreo semanal encendido por defecto.
    expect(ov.body.settings).toMatchObject({ weeklyEnabled: true, maxPages: 2000, pauseMs: 1000 });

    const issues = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/issues`)
      .set(asSuper());
    expect(issues.status).toBe(200);
    const has = (type: string, path: string) =>
      (issues.body.items as { type: string; url: string }[]).some(
        (i) => i.type === type && i.url === `${P}${path}`,
      );
    for (const [type, path] of [
      ['http_error', '/rota'],
      ['broken_link', '/rota'],
      ['redirected_link', '/vieja'],
      ['robots_blocked', '/privado/zona'],
      ['title_duplicate', '/blog'],
      ['title_duplicate', '/blog/entrada'],
      ['description_missing', '/blog/entrada'],
      ['h1_missing', '/blog/entrada'],
      ['images_without_alt', '/blog/entrada'],
      ['deep_page', '/blog/nivel4'],
      ['orphan_page', '/huerfana'],
      ['orphan_page', '/con-impresiones'],
      ['sitemap_unreachable', '/sitemap-2.xml'],
      ['sitemap_error', '/sitemap-roto'],
      ['sitemap_redirect', '/sitemap-redirige'],
      ['sitemap_noindex', '/noindex-sitemap'],
    ] as const) {
      expect([type, path, has(type, path)]).toEqual([type, path, true]);
    }
    const first = issues.body.items[0];
    expect(first.severity).toBe('high');
    expect(first.what.length).toBeGreaterThan(10);
    expect(first.how.length).toBeGreaterThan(10);
    expect(first.isNew).toBe(true);

    // Filtros y CSV.
    const high = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/issues`)
      .query({ severity: 'high', group: 'sitemap' })
      .set(asSuper());
    expect((high.body.items as { severity: string }[]).every((i) => i.severity === 'high')).toBe(
      true,
    );
    expect(
      (
        await http_()
          .get(`/admin/seo/projects/${platformProject}/crawl/issues`)
          .query({ severity: 'x' })
          .set(asSuper())
      ).status,
    ).toBe(400);
    const csv = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/issues/csv`)
      .set(asSuper());
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Qué hacer');

    // Páginas, huérfanas y ficha de una URL con los enlaces que entran y salen.
    const orphans = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/pages`)
      .query({ filter: 'orphans' })
      .set(asSuper());
    const orphanUrls = (orphans.body.items as { url: string }[]).map((p) => p.url);
    expect(orphanUrls).toEqual(expect.arrayContaining([`${P}/huerfana`, `${P}/con-impresiones`]));
    const detail = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/page`)
      .query({ url: '/blog/entrada' })
      .set(asSuper());
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ depth: 2, inlinks: 1, status: 200, imagesWithoutAlt: 1 });
    expect(detail.body.linksIn).toEqual([`${P}/blog`]);
    expect(detail.body.linksOut).toEqual([`${P}/blog/nivel3`]);
    expect((detail.body.issuesList as { type: string }[]).map((i) => i.type)).toEqual(
      expect.arrayContaining(['h1_missing', 'description_missing']),
    );
    const blocked = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/page`)
      .query({ url: '/privado/zona' })
      .set(asSuper());
    expect(blocked.body).toMatchObject({
      robotsBlocked: true,
      status: null,
      robotsRule: 'Disallow: /privado',
    });
  });

  it('confirma el motivo de la indexación, el enlazado interno y la oportunidad nueva', async () => {
    const findings = await http_()
      .get(`/admin/seo/projects/${platformProject}/diagnostics/index-findings`)
      .set(asSuper());
    const portal = (
      findings.body.items as {
        url: string;
        category: string;
        crawl: { confirmed: boolean; text: string; status: number } | null;
      }[]
    ).find((f) => f.url === `${P}/portal`);
    expect(portal?.category).toBe('private');
    expect(portal?.crawl).toMatchObject({ confirmed: true, status: 200 });
    expect(portal?.crawl?.text).toContain('no tiene «noindex»');

    const links = await http_()
      .get(`/admin/seo/projects/${platformProject}/crawl/internal-links`)
      .set(asSuper());
    expect(links.status).toBe(200);
    const precios = (
      links.body.items as {
        url: string;
        inlinks: number;
        few: boolean;
        sources: string[];
        suggestions: { url: string }[];
        keywords: { keyword: string }[];
      }[]
    ).find((i) => i.url === `${P}/precios`);
    expect(precios).toMatchObject({ inlinks: 1, few: true, sources: [`${P}/`] });
    expect(precios!.keywords.map((k) => k.keyword)).toEqual(['precio trastero']);
    // Sugerida /blog (sale para «precio trastero valencia»); la portada ya la enlaza.
    expect(precios!.suggestions.map((s) => s.url)).toEqual([`${P}/blog`]);

    const recalc = await http_()
      .post(`/admin/seo/projects/${platformProject}/opportunity-engine/recalculate`)
      .set(asSuper());
    expect([200, 201]).toContain(recalc.status);
    const opps = await http_()
      .get(`/admin/seo/projects/${platformProject}/opportunity-engine`)
      .query({ type: 'internal_links' })
      .set(asSuper());
    const opp = (
      opps.body.items as {
        type: string;
        query: string;
        score: number;
        metrics: { internalLinks: { inlinks: number; suggestions: { url: string }[] } };
      }[]
    ).find((o) => o.query === 'precio trastero');
    expect(opp?.type).toBe('internal_links');
    expect(opp?.metrics.internalLinks.inlinks).toBe(1);
    expect(opp?.metrics.internalLinks.suggestions[0]?.url).toBe(`${P}/blog`);
    expect(opp!.score).toBeGreaterThan(0);
  });

  it('alertas: páginas que dan error nuevas y URL objetivo con «noindex»', async () => {
    const check = await http_()
      .post(`/admin/seo/projects/${platformProject}/alerts/check`)
      .set(asSuper());
    expect([200, 201]).toContain(check.status);
    const alerts = await http_()
      .get(`/admin/seo/projects/${platformProject}/alerts`)
      .query({ status: 'live' })
      .set(asSuper());
    const items = alerts.body.items as { type: string; severity: string; title: string }[];
    const errors = items.find((x) => x.type === 'crawl_errors');
    expect(errors?.title).toContain('2 páginas nuevas dan error');
    const critical = items.filter((x) => x.type === 'crawl_critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ severity: 'high' });
    expect(critical[0]!.title).toContain('/noindex-sitemap');

    // El informe lleva el resumen del último rastreo.
    const preview = await http_()
      .get(`/admin/seo/projects/${platformProject}/reports/preview`)
      .query({ kind: 'weekly' })
      .set(asSuper());
    expect(preview.status).toBe(200);
    expect(preview.body.crawl).toMatchObject({ errors: 2 });
    expect(preview.body.crawl.high).toBeGreaterThan(0);
    expect((preview.body.highlights as string[]).some((h) => h.startsWith('Último rastreo'))).toBe(
      true,
    );
  });

  it('vuelve a rastrear: resueltas y nuevas sin pisar el estado ni las notas', async () => {
    const list = async () =>
      (
        await http_()
          .get(`/admin/seo/projects/${platformProject}/crawl/issues`)
          .query({ view: 'all' })
          .set(asSuper())
      ).body.items as {
        id: string;
        type: string;
        url: string;
        status: string;
        notes: string | null;
        active: boolean;
        isNew: boolean;
        returnedAt: string | null;
      }[];
    const before = await list();
    const desc = before.find(
      (i) => i.type === 'description_missing' && i.url === `${P}/blog/entrada`,
    )!;
    const h1 = before.find((i) => i.type === 'h1_missing' && i.url === `${P}/blog/entrada`)!;
    expect(
      (
        await http_()
          .patch(`/admin/seo/projects/${platformProject}/crawl/issues/${desc.id}`)
          .set(asSuper())
          .send({ status: 'reviewed', notes: 'Lo mira Ana' })
      ).body,
    ).toMatchObject({ status: 'reviewed', notes: 'Lo mira Ana' });
    // Dada por arreglada sin estarlo: vuelve como nueva.
    await http_()
      .patch(`/admin/seo/projects/${platformProject}/crawl/issues/${h1.id}`)
      .set(asSuper())
      .send({ status: 'fixed' });

    version = 2;
    const start = await http_().post(`/admin/seo/projects/${platformProject}/crawl`).set(asSuper());
    const second = start.body.crawl.id as string;
    expect(second).not.toBe(firstCrawl);
    expect(await waitCrawl(second)).toMatchObject({ status: 'done' });

    const after = await list();
    const find = (type: string, path: string) =>
      after.find((i) => i.type === type && i.url === `${P}${path}`)!;
    expect(find('http_error', '/rota')).toMatchObject({ active: false, status: 'fixed' });
    expect(find('broken_link', '/rota')).toMatchObject({ active: false });
    expect(find('h1_missing', '/precios')).toMatchObject({
      active: true,
      isNew: true,
      status: 'new',
    });
    expect(find('description_missing', '/blog/entrada')).toMatchObject({
      active: true,
      isNew: false,
      status: 'reviewed',
      notes: 'Lo mira Ana',
    });
    const back = find('h1_missing', '/blog/entrada');
    expect(back.status).toBe('new');
    expect(back.returnedAt).not.toBeNull();

    const ov = await http_().get(`/admin/seo/projects/${platformProject}/crawl`).set(asSuper());
    expect(ov.body.last.id).toBe(second);
    expect(ov.body.last.summary.resolvedIssues).toBeGreaterThanOrEqual(2);
    expect(ov.body.last.summary.newIssues).toBeGreaterThanOrEqual(1);
    expect(ov.body.history.map((h: { id: string }) => h.id)).toEqual([second, firstCrawl]);

    // Sin errores nuevos, la alerta del rastreo anterior se resuelve.
    await http_().post(`/admin/seo/projects/${platformProject}/alerts/check`).set(asSuper());
    const alerts = await http_()
      .get(`/admin/seo/projects/${platformProject}/alerts`)
      .query({ status: 'live' })
      .set(asSuper());
    expect((alerts.body.items as { type: string }[]).some((x) => x.type === 'crawl_errors')).toBe(
      false,
    );
  });

  it('un solo rastreo vivo por proyecto, cancelable, y se retoma tras un reinicio', async () => {
    crawler.pauseOverrideMs = 400;
    try {
      const one = await http_().post('/seo-advanced/crawl').set(a());
      expect(one.status).toBe(200);
      const two = await http_().post('/seo-advanced/crawl').set(a());
      expect(two.body).toMatchObject({ alreadyRunning: true });
      expect(two.body.crawl.id).toBe(one.body.crawl.id);
      const cancel = await http_().post(`/seo-advanced/crawl/${one.body.crawl.id}/cancel`).set(a());
      expect(cancel.status).toBe(204);
      expect(await waitCrawl(one.body.crawl.id, ['cancelled'])).toMatchObject({
        status: 'cancelled',
      });
    } finally {
      crawler.pauseOverrideMs = 0;
    }

    // Un rastreo «en curso» sin señal (el proceso murió) se retoma; uno con señal, no.
    const site = {
      startUrl: `https://${tenantHost}/`,
      host: tenantHost,
      scheme: 'https',
      pathPrefix: '/',
    };
    const stale = await withAdminDb((db) =>
      db.seoCrawl.create({
        data: {
          tenantId: owner.tenantId,
          projectId: tenantProject,
          status: 'running',
          startUrl: site.startUrl,
          site,
          startedAt: new Date(Date.now() - 20 * 60_000),
          heartbeatAt: new Date(Date.now() - 10 * 60_000),
        },
      }),
    );
    await crawler.process(stale.id);
    expect(await waitCrawl(stale.id)).toMatchObject({ status: 'done' });
    const fresh = await withAdminDb((db) =>
      db.seoCrawl.create({
        data: {
          tenantId: owner.tenantId,
          projectId: tenantProject,
          status: 'running',
          startUrl: site.startUrl,
          site,
          startedAt: new Date(),
          heartbeatAt: new Date(),
        },
      }),
    );
    await crawler.process(fresh.id);
    const still = await withAdminDb((db) =>
      db.seoCrawl.findUniqueOrThrow({ where: { id: fresh.id } }),
    );
    expect(still.status).toBe('running');
    await http_().post(`/seo-advanced/crawl/${fresh.id}/cancel`).set(a());

    const ov = await http_().get('/seo-advanced/crawl').set(a());
    expect(ov.body.settings).toMatchObject({ weeklyEnabled: false, maxPages: 500 });
    expect(ov.body.last.id).toBe(stale.id);
    const issues = await http_().get('/seo-advanced/crawl/issues').set(a());
    // Web del tenant sin mapa del sitio.
    expect((issues.body.items as { type: string }[]).map((i) => i.type)).toContain(
      'sitemap_missing',
    );
  });

  it('ajustes, aislamiento entre tenants y soporte solo en lectura', async () => {
    const put = await http_()
      .put('/seo-advanced/crawl/settings')
      .set(a())
      .send({ weeklyEnabled: true, weekday: 3, hour: 22, maxPages: 5000, excludePaths: ['/blog'] });
    expect(put.status).toBe(400);
    const ok = await http_()
      .put('/seo-advanced/crawl/settings')
      .set(a())
      .send({ weeklyEnabled: true, weekday: 3, hour: 22, maxPages: 300, excludePaths: ['/blog'] });
    expect(ok.body).toMatchObject({
      weeklyEnabled: true,
      weekday: 3,
      hour: 22,
      maxPages: 300,
      excludePaths: ['/blog'],
    });

    // El otro tenant no ve nada del primero.
    const issueOfA = (await http_().get('/seo-advanced/crawl/issues').set(a())).body.items[0];
    const ovB = await http_().get('/seo-advanced/crawl').set(b());
    expect(ovB.body).toMatchObject({ last: null, live: null, history: [] });
    expect((await http_().get('/seo-advanced/crawl/issues').set(b())).body.total).toBe(0);
    expect(
      (
        await http_()
          .patch(`/seo-advanced/crawl/issues/${issueOfA.id}`)
          .set(b())
          .send({ status: 'ok' })
      ).status,
    ).toBe(404);
    expect(
      (
        await http_()
          .get('/seo-advanced/crawl/page')
          .query({ url: `https://${tenantHost}/a` })
          .set(b())
      ).status,
    ).toBe(404);

    // El super admin lee el proyecto del tenant, pero no rastrea ni cambia nada de él.
    expect(
      (await http_().get(`/admin/seo/projects/${tenantProject}/crawl`).set(asSuper())).status,
    ).toBe(200);
    expect(
      (await http_().post(`/admin/seo/projects/${tenantProject}/crawl`).set(asSuper())).status,
    ).toBe(404);
    // Soporte: solo lectura.
    expect(
      (await http_().get(`/admin/seo/projects/${platformProject}/crawl`).set(asSupport())).status,
    ).toBe(200);
    expect(
      (await http_().post(`/admin/seo/projects/${platformProject}/crawl`).set(asSupport())).status,
    ).toBe(403);
    expect(
      (
        await http_()
          .put(`/admin/seo/projects/${platformProject}/crawl/settings`)
          .set(asSupport())
          .send({ pauseMs: 2000 })
      ).status,
    ).toBe(403);

    // Sin el extra, nada.
    await setTenantFeatureOverride(other.slug, 'seo_advanced', false);
    expect((await http_().get('/seo-advanced/crawl').set(b())).status).toBe(403);
  });
});
