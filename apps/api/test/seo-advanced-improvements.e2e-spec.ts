import { EventEmitter2 } from '@nestjs/event-emitter';
import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { SeoAutoStartService } from '../src/modules/seo-advanced/improvements/seo-auto-start.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { scopedUser } from './helpers/scoped-user';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-mejoras-super@storageos.local';
const PREFIX = 'E2E mejoras ';
const OWN = 'e2e-mejoras-seo.es';
const RIVAL = 'e2e-mejoras-rival.es';
const DIRECTORY = 'e2e-mejoras-directorio.es';
const KW = 'e2e mejoras trasteros valencia';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/**
 * Las mejoras de SEO Avanzado de punta a punta: marca frente a no marca, zonas,
 * móvil, competencia (con un competidor de directorio), CSV de SISTRIX, palabras
 * en lote, anotaciones propuestas y que cada tenant solo ve lo suyo.
 */
describe('SEO Avanzado: mejoras (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const tenantIds: string[] = [];
  let a: VerifiedUser;
  let b: VerifiedUser;
  let projectId = '';
  let domainId = '';
  const base = () => `/admin/seo/projects/${projectId}`;

  async function cleanup(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.seoKeyword.deleteMany({ where: { keyword: { startsWith: 'e2e mejoras' } } });
      await db.superAdmin.deleteMany({ where: { email: SUPER_EMAIL } });
    });
  }

  beforeAll(async () => {
    await cleanup();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb((db) =>
      db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Mejoras', role: 'superadmin' },
      }),
    );
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    a = await registerVerifiedUser(app, 'seomejoraa');
    b = await registerVerifiedUser(app, 'seomejorab');
    tenantIds.push(a.tenantId, b.tenantId);
    await setTenantFeatureOverride(a.slug, 'seo_advanced', true);
    await setTenantFeatureOverride(b.slug, 'seo_advanced', true);
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await cleanupTenantsById(tenantIds);
  });

  // ------------------------------------------------ datos de la plataforma

  it('prepara un proyecto con datos de Google (búsquedas, páginas y dispositivos)', async () => {
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'national', brandTerms: ['Guárdalo'] });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    domainId = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: {
            projectId,
            domain: OWN,
            role: 'primary',
            gscProperty: `sc-domain:${OWN}`,
            dataUntil: asDate(TODAY),
            syncedUntil: asDate(TODAY),
          },
        }),
      )
    ).id;
    const rows: object[] = [];
    const row = (d: string, grain: string, o: Record<string, unknown>) => ({
      tenantId: null,
      domainId,
      grain,
      date: asDate(d),
      query: '',
      page: '',
      device: '',
      country: '',
      ctr: 0,
      position: 8,
      clicks: 0,
      impressions: 0,
      ...o,
    });
    for (let d = shiftDate(TODAY, -60); d <= TODAY; d = shiftDate(d, 1)) {
      rows.push(row(d, 'site', { clicks: 9, impressions: 210 }));
      rows.push(
        row(d, 'query', { query: 'guardalo valencia', clicks: 5, impressions: 50, position: 1 }),
      );
      rows.push(
        row(d, 'query', { query: 'trasteros valencia', clicks: 3, impressions: 100, position: 9 }),
      );
      rows.push(
        row(d, 'query', { query: 'trasteros mislata', clicks: 1, impressions: 60, position: 14 }),
      );
      rows.push(
        row(d, 'query_page', {
          query: 'trasteros valencia',
          page: `https://${OWN}/precios`,
          clicks: 3,
          impressions: 100,
        }),
      );
      rows.push(
        row(d, 'query_page', {
          query: 'guardalo valencia',
          page: `https://${OWN}/`,
          clicks: 5,
          impressions: 50,
        }),
      );
      rows.push(
        row(d, 'page_device', {
          page: `https://${OWN}/precios`,
          device: 'MOBILE',
          clicks: 1,
          impressions: 40,
          position: 9,
        }),
      );
      rows.push(
        row(d, 'page_device', {
          page: `https://${OWN}/precios`,
          device: 'DESKTOP',
          clicks: 5,
          impressions: 40,
          position: 6,
        }),
      );
      rows.push(
        row(d, 'page_device', {
          page: `https://${OWN}/`,
          device: 'MOBILE',
          clicks: 2,
          impressions: 25,
          position: 3,
        }),
      );
      rows.push(
        row(d, 'page_device', {
          page: `https://${OWN}/`,
          device: 'DESKTOP',
          clicks: 2,
          impressions: 25,
          position: 3,
        }),
      );
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );
  });

  it('marca frente a no marca: dos indicadores y el filtro de las tablas', async () => {
    const split = await http().get(`${base()}/brand?period=28d`).set(asSuper());
    expect(split.status).toBe(200);
    expect(split.body.needsTerms).toBe(false);
    // 28 días: guardalo valencia = 5 clics/día; el resto, 4 al día.
    expect(split.body.brand.clicks).toBe(5 * 28);
    expect(split.body.nonBrand.clicks).toBe(4 * 28);
    expect(split.body.brand.clickShare).toBeCloseTo(5 / 9, 2);

    const non = await http().get(`${base()}/queries?period=28d&brand=nonbrand`).set(asSuper());
    expect(non.status).toBe(200);
    expect(non.body.items.map((i: { key: string }) => i.key).sort()).toEqual([
      'trasteros mislata',
      'trasteros valencia',
    ]);
    const only = await http().get(`${base()}/queries?period=28d&brand=brand`).set(asSuper());
    expect(only.body.items.map((i: { key: string }) => i.key)).toEqual(['guardalo valencia']);
    // Las páginas se filtran por las búsquedas que las traen.
    const pages = await http().get(`${base()}/pages?period=28d&brand=brand`).set(asSuper());
    expect(pages.body.items.map((i: { key: string }) => i.key)).toEqual([`https://${OWN}/`]);
  });

  it('sin términos de marca, invita a ponerlos', async () => {
    const other = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}sin marca`, strategy: 'national' });
    const res = await http().get(`/admin/seo/projects/${other.body.id}/brand`).set(asSuper());
    expect(res.status).toBe(200);
    expect(res.body.needsTerms).toBe(true);
  });

  it('zonas: se guardan, filtran las búsquedas y generan la oportunidad «sin página»', async () => {
    const put = await http()
      .put(`${base()}/areas`)
      .set(asSuper())
      .send({ areas: ['Mislata', 'mislata', 'Quart de Poblet'] });
    expect(put.status).toBe(200);
    expect(put.body.areas).toEqual(['Mislata', 'Quart de Poblet']);

    const filtered = await http().get(`${base()}/queries?period=28d&area=Mislata`).set(asSuper());
    expect(filtered.body.items.map((i: { key: string }) => i.key)).toEqual(['trasteros mislata']);

    const recalc = await http().post(`${base()}/opportunity-engine/recalculate`).set(asSuper());
    expect(recalc.status).toBe(201);
    const list = await http().get(`${base()}/opportunity-engine?limit=100`).set(asSuper());
    const zone = (
      list.body.items as { type: string; query: string; factors: { key: string }[] }[]
    ).find((o) => o.type === 'zone_no_page');
    expect(zone).toBeTruthy();
    expect(zone?.query).toBe('trasteros mislata');
    expect(zone?.factors.some((f) => f.key === 'zone')).toBe(true);
  });

  it('año anterior: avisa si no hay histórico, en la oportunidad y en el antes y después', async () => {
    const list = await http().get(`${base()}/opportunity-engine?limit=100`).set(asSuper());
    const id = (list.body.items as { id: string; type: string }[]).find(
      (o) => o.type === 'zone_no_page',
    )?.id as string;
    const year = await http().get(`${base()}/opportunities/${id}/year-ago`).set(asSuper());
    expect(year.status).toBe(200);
    expect(year.body.available).toBe(false);
    expect(year.body.message).toContain('histórico');
    // Otro tenant no puede mirar la de la plataforma.
    const B = { Authorization: `Bearer ${b.accessToken}` };
    expect((await http().post('/seo-advanced/project').set(B).send({})).status).toBe(201);
    expect((await http().get(`/seo-advanced/opportunities/${id}/year-ago`).set(B)).status).toBe(
      404,
    );

    const change = await http()
      .post(`${base()}/plan/changes`)
      .set(asSuper())
      .send({
        date: shiftDate(TODAY, -40),
        type: 'title_meta',
        title: 'Título nuevo',
        urls: [`https://${OWN}/precios`],
      });
    expect(change.status).toBe(201);
    const detail = await http().get(`${base()}/plan/changes/${change.body.id}`).set(asSuper());
    const w7 = detail.body.windows.find((w: { days: number }) => w.days === 7);
    expect(w7.status).toBe('ready');
    expect(w7.yearAgo.available).toBe(false);
    expect(w7.yearAgo.message).toContain('histórico');
  });

  it('páginas en móvil: marca la que va claramente peor', async () => {
    const res = await http().get(`${base()}/pages/devices?period=28d`).set(asSuper());
    expect(res.status).toBe(200);
    const precios = res.body.items.find((i: { page: string }) => i.page.endsWith('/precios'));
    const home = res.body.items.find((i: { page: string }) => i.page.endsWith(`${OWN}/`));
    expect(precios.worseOnMobile).toBe(true);
    expect(precios.reason).toContain('CTR');
    expect(home.worseOnMobile).toBe(false);
    const onlyWorse = await http()
      .get(`${base()}/pages/devices?period=28d&onlyWorse=1`)
      .set(asSuper());
    expect(onlyWorse.body.items).toHaveLength(1);
  });

  // ------------------------------------------------------- competencia

  it('competencia: quién sube y quién baja, por grupo y en un directorio', async () => {
    const comp = await http().post(`${base()}/competitors`).set(asSuper()).send({ domain: RIVAL });
    expect(comp.status).toBe(201);
    const dir = await http()
      .post(`${base()}/competitors`)
      .set(asSuper())
      .send({ domain: DIRECTORY, pathPrefix: '/valencia/' });
    expect(dir.status).toBe(201);
    expect(dir.body.find((c: { domain: string }) => c.domain === DIRECTORY).pathPrefix).toBe(
      '/valencia/',
    );
    const bad = await http()
      .post(`${base()}/competitors`)
      .set(asSuper())
      .send({ domain: 'e2e-mejoras-otro.es', pathPrefix: '/a b/' });
    expect(bad.status).toBe(400);

    const kws = await http()
      .post(`${base()}/keywords`)
      .set(asSuper())
      .send({ keywords: [KW], groupName: 'Valencia' });
    expect(kws.status).toBe(201);
    const keywordId = await withAdminDb(async (db) => {
      const k = await db.seoKeyword.findFirstOrThrow({ where: { keyword: KW } });
      const serp = (
        date: string,
        position: number,
        domain: string,
        url: string,
        title?: string,
      ) => ({
        tenantId: null,
        keywordId: k.id,
        country: 'es',
        provider: 'sistrix_mcp',
        sampleDate: asDate(date),
        position,
        domain,
        url,
        title: title ?? null,
      });
      const before = shiftDate(TODAY, -7);
      await db.seoSerpResult.createMany({
        data: [
          serp(before, 8, OWN, `https://${OWN}/precios`),
          serp(before, 3, RIVAL, `https://${RIVAL}/`),
          serp(before, 2, DIRECTORY, `https://${DIRECTORY}/madrid/centro`),
          serp(TODAY, 5, OWN, `https://${OWN}/precios`, 'Precios de trasteros'),
          serp(TODAY, 6, RIVAL, `https://${RIVAL}/`),
          serp(TODAY, 12, DIRECTORY, `https://${DIRECTORY}/valencia/centro`),
          serp(TODAY, 2, DIRECTORY, `https://${DIRECTORY}/madrid/centro`),
        ],
      });
      return k.id;
    });
    expect(keywordId).toBeTruthy();

    const movers = await http().get(`${base()}/competition/movers`).set(asSuper());
    expect(movers.status).toBe(200);
    const find = (domain: string) =>
      movers.body.items.find((i: { domain: string }) => i.domain === domain);
    // Tú subes 3 puestos, el rival baja 3 y el directorio solo cuenta lo de /valencia/.
    expect(find(OWN).diff).toBe(3);
    expect(find(OWN).title).toBe('Precios de trasteros');
    expect(find(RIVAL).diff).toBe(-3);
    expect(find(DIRECTORY).previous).toBeNull();
    expect(find(DIRECTORY).current).toBe(12);

    const groups = await http().get(`${base()}/competition/groups`).set(asSuper());
    const valencia = groups.body.groups.find(
      (g: { group: string | null }) => g.group === 'Valencia',
    );
    expect(valencia.sampled).toBe(1);
    const mine = valencia.cells.find((c: { domain: string }) => c.domain === OWN);
    expect(mine.averagePosition).toBe(5);

    const pk = (await http().get(`${base()}/keywords`).set(asSuper())).body[0].id as string;
    const evo = await http()
      .get(`${base()}/competition/evolution?domain=${RIVAL}&keywordId=${pk}`)
      .set(asSuper());
    expect(evo.status).toBe(200);
    expect(evo.body.points.map((p: { position: number | null }) => p.position)).toEqual([3, 6]);
    expect(evo.body.mine.map((p: { position: number | null }) => p.position)).toEqual([8, 5]);
  });

  // --------------------------------------------------- CSV de SISTRIX

  it('CSV de SISTRIX: vista previa, importación sin duplicar y borrado', async () => {
    const csv = Buffer.from(
      'Palabra clave;Posición;URL\ne2e mejoras alquiler trastero;4;https://x.es/a\ne2e mejoras guardamuebles;9;\nsin posición;x;\n',
    );
    const preview = await http()
      .post(`${base()}/sistrix-imports/preview`)
      .set(asSuper())
      .field('kind', 'domain_keywords')
      .field('domain', OWN)
      .attach('file', csv, 'palabras.csv');
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toBe(2);
    expect(preview.body.skipped).toBe(1);

    const done = await http()
      .post(`${base()}/sistrix-imports`)
      .set(asSuper())
      .field('kind', 'domain_keywords')
      .field('domain', OWN)
      .attach('file', csv, 'palabras.csv');
    expect(done.status).toBe(201);
    expect(done.body.rows).toBe(2);
    const stored = await withAdminDb((db) =>
      db.seoDomainKeyword.findMany({ where: { domain: OWN, provider: 'manual_import' } }),
    );
    expect(stored).toHaveLength(2);

    // El mismo día no se duplica.
    const again = await http()
      .post(`${base()}/sistrix-imports`)
      .set(asSuper())
      .field('kind', 'domain_keywords')
      .field('domain', OWN)
      .attach('file', csv, 'palabras.csv');
    expect(again.body.rows).toBe(0);

    // Un dominio que no es del proyecto ni competidor se rechaza.
    const foreign = await http()
      .post(`${base()}/sistrix-imports/preview`)
      .set(asSuper())
      .field('kind', 'domain_keywords')
      .field('domain', 'ajeno.es')
      .attach('file', csv, 'palabras.csv');
    expect(foreign.status).toBe(400);
    const wrong = await http()
      .post(`${base()}/sistrix-imports/preview`)
      .set(asSuper())
      .field('kind', 'serp')
      .field('keyword', 'e2e mejoras algo')
      .attach('file', Buffer.from('Nombre;Otra\na;b'), 'mal.csv');
    expect(wrong.status).toBe(400);

    const list = await http().get(`${base()}/sistrix-imports`).set(asSuper());
    expect(list.body).toHaveLength(2);
    expect(
      (await http().delete(`${base()}/sistrix-imports/${done.body.id}`).set(asSuper())).status,
    ).toBe(204);
    expect(
      await withAdminDb((db) =>
        db.seoDomainKeyword.count({ where: { domain: OWN, provider: 'manual_import' } }),
      ),
    ).toBe(0);
  });

  it('probar la API sin autorización no gasta nada', async () => {
    const res = await http()
      .post('/admin/seo/sistrix/api/probe')
      .set(asSuper())
      .send({ method: 'domain.kwcount.seo' });
    expect(res.status).toBe(400);
    expect(['sistrix_api_not_ready', 'sistrix_api_not_authorized']).toContain(res.body.code);
  });

  it('el evento de dominio conectado hace que arranque solo el rastreo y la medición', async () => {
    const C = await registerVerifiedUser(app, 'seomejorac');
    tenantIds.push(C.tenantId);
    await setTenantFeatureOverride(C.slug, 'seo_advanced', true);
    const token = { Authorization: `Bearer ${C.accessToken}` };
    const project = await http().post('/seo-advanced/project').set(token).send({});
    expect(project.status).toBe(201);
    const auto = app.get(SeoAutoStartService);
    const start = jest.spyOn(auto, 'start').mockResolvedValue({
      crawl: true,
      pagespeed: true,
      monthly: true,
    });
    const before = process.env.SEO_AUTO_START;
    process.env.SEO_AUTO_START = 'on';
    try {
      app.get(EventEmitter2).emit('seo.domain_connected', {
        tenantId: C.tenantId,
        projectId: project.body.id,
      });
      for (let i = 0; i < 40 && start.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(start).toHaveBeenCalledWith(C.tenantId, project.body.id);
    } finally {
      process.env.SEO_AUTO_START = before;
      start.mockRestore();
    }
  });

  // ------------------------------------------------- un tenant, lo suyo

  it('zonas, palabras en lote y anotaciones: cada tenant ve lo suyo', async () => {
    const A = { Authorization: `Bearer ${a.accessToken}` };
    const B = { Authorization: `Bearer ${b.accessToken}` };
    expect((await http().post('/seo-advanced/project').set(A).send({})).status).toBe(201);

    // Zonas: las de A no se ven en B; quien solo lee no las cambia.
    const put = await http()
      .put('/seo-advanced/areas')
      .set(A)
      .send({ areas: ['Mislata'] });
    expect(put.status).toBe(200);
    expect((await http().get('/seo-advanced/areas').set(B)).body.areas).toEqual([]);
    const reader = await scopedUser(app, a, { role: 'readonly', facilityIds: [], tag: 'seomej' });
    expect(
      (
        await http()
          .put('/seo-advanced/areas')
          .set(reader)
          .send({ areas: ['X'] })
      ).status,
    ).toBe(403);
    expect((await http().get('/seo-advanced/areas').set(reader)).status).toBe(200);

    // Palabras en lote: B no toca las de A.
    const added = await http()
      .post('/seo-advanced/keywords')
      .set(A)
      .send({ keywords: ['e2e mejoras uno', 'e2e mejoras dos'] });
    expect(added.status).toBe(201);
    const ids = (added.body as { id: string }[]).map((k) => k.id);
    expect(
      (await http().patch('/seo-advanced/keywords-batch').set(B).send({ ids, priority: 1 })).body
        .updated,
    ).toBe(0);
    const batch = await http()
      .patch('/seo-advanced/keywords-batch')
      .set(A)
      .send({ ids, groupName: 'Lote', priority: 1, intent: 'do' });
    expect(batch.status).toBe(200);
    expect(batch.body.updated).toBe(2);
    const listed = await http().get('/seo-advanced/keywords').set(A);
    expect(
      (listed.body as { groupName: string | null; priority: number }[]).every(
        (k) => k.groupName === 'Lote' && k.priority === 1,
      ),
    ).toBe(true);
    const renamed = await http()
      .post('/seo-advanced/keyword-groups/rename')
      .set(A)
      .send({ from: 'Lote', to: 'Renombrado' });
    expect(renamed.body.updated).toBe(2);
    expect(
      (
        await http()
          .post('/seo-advanced/keyword-groups/rename')
          .set(B)
          .send({ from: 'Renombrado', to: 'Mío' })
      ).body.updated,
    ).toBe(0);
    expect((await http().patch('/seo-advanced/keywords-batch').set(A).send({ ids })).status).toBe(
      400,
    );

    // Anotaciones: el registro de actividad de A propone, B no ve nada.
    const log = (action: string, changes: object) =>
      withAdminDb((db) =>
        db.auditLog.create({
          data: { tenantId: a.tenantId, action, entityType: 'BlogPost', changes },
        }),
      );
    const published = await log('blog_post.published', {
      title: 'Entrada de prueba',
      slug: 'entrada-de-prueba',
      isPublished: true,
    });
    const noisy = await log('blog_post.published', {
      title: 'Otra',
      slug: 'otra',
      isPublished: true,
    });
    const proposals = await http().get('/seo-advanced/annotations/proposals').set(A);
    expect(proposals.status).toBe(200);
    expect(proposals.body.items.map((i: { sourceRef: string }) => i.sourceRef).sort()).toEqual(
      [published.id, noisy.id].sort(),
    );
    expect((await http().get('/seo-advanced/annotations/proposals').set(B)).body.items).toEqual([]);
    // B no puede confirmar lo de A.
    expect(
      (
        await http()
          .post('/seo-advanced/annotations/proposals/confirm')
          .set(B)
          .send({ sourceRef: published.id })
      ).status,
    ).toBe(404);
    const ok = await http()
      .post('/seo-advanced/annotations/proposals/confirm')
      .set(A)
      .send({ sourceRef: published.id });
    expect(ok.status).toBe(200);
    expect(ok.body.type).toBe('new_page');
    expect(ok.body.urls).toEqual(['/blog/entrada-de-prueba']);
    // Confirmada: no se propone otra vez y la actuación existe.
    const left = await http().get('/seo-advanced/annotations/proposals').set(A);
    expect(left.body.items.map((i: { sourceRef: string }) => i.sourceRef)).toEqual([noisy.id]);
    expect(
      (
        await http()
          .post('/seo-advanced/annotations/proposals/dismiss')
          .set(A)
          .send({ sourceRefs: [noisy.id] })
      ).status,
    ).toBe(204);
    expect((await http().get('/seo-advanced/annotations/proposals').set(A)).body.items).toEqual([]);
    const changes = await http().get('/seo-advanced/plan/changes').set(A);
    expect(
      changes.body.items.some((c: { title: string }) => c.title.includes('Entrada publicada')),
    ).toBe(true);
    expect((await http().get('/seo-advanced/plan/changes').set(B)).body.items).toHaveLength(0);
  });
});
