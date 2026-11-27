import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-diag-super@storageos.local';
const SUPPORT_EMAIL = 'seo-diag-support@storageos.local';
const PREFIX = 'E2E diagnóstico ';
const DOMAIN = 'e2e-diagnostico.es';
const OLD_DOMAIN = 'e2e-diagnostico-antiguo.es';
const URL = (path: string) => `https://${DOMAIN}${path}`;

/** Último día con datos del dominio sembrado y días relativos a él. */
const LAST = shiftDate(new Date().toISOString().slice(0, 10), -3);
const day = (offset: number) => new Date(`${shiftDate(LAST, -offset)}T00:00:00Z`);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

type Row = {
  tenantId: string | null;
  domainId: string;
  grain: string;
  date: Date;
  query: string;
  page: string;
  device: string;
  country: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/**
 * Una búsqueda día a día: en cada día, las páginas con sus impresiones (y los
 * clics). Escribe el cruce `query` (la suma del día) y `query_page`.
 */
function seedDays(
  domainId: string,
  query: string,
  days: { offset: number; pages: { page: string; impressions: number; clicks: number }[] }[],
  position = 6,
): Row[] {
  const rows: Row[] = [];
  for (const d of days) {
    const base = {
      tenantId: null,
      domainId,
      date: day(d.offset),
      query,
      device: '',
      country: '',
      position,
    };
    const imp = d.pages.reduce((n, p) => n + p.impressions, 0);
    const clk = d.pages.reduce((n, p) => n + p.clicks, 0);
    rows.push({ ...base, grain: 'query', page: '', clicks: clk, impressions: imp, ctr: 0 });
    for (const p of d.pages) {
      rows.push({
        ...base,
        grain: 'query_page',
        page: p.page,
        clicks: p.clicks,
        impressions: p.impressions,
        ctr: 0,
      });
    }
  }
  return rows;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => from + k);

describe('SEO Avanzado: diagnóstico (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let projectId = '';
  let domainId = '';
  const tenantIds: string[] = [];
  const base = () => `/admin/seo/projects/${projectId}/diagnostics`;
  const kw = () => `/admin/seo/projects/${projectId}/keywords`;

  type Tracked = {
    id: string;
    keyword: string;
    targetStatus: string;
    googlePage: string | null;
    suggestedUrl: string | null;
    clicks: number;
    impressions: number;
    position: number | null;
    groupName: string | null;
    notes: string | null;
    intent: string | null;
    intentSource: string | null;
    source: string;
  };
  const tracked = async (): Promise<Tracked[]> => {
    const res = await http()
      .get(`${base()}/tracked-keywords`)
      .query({ days: '28' })
      .set(asSupport());
    expect(res.status).toBe(200);
    return res.body.items as Tracked[];
  };
  const byWord = (list: Tracked[], w: string) => list.find((k) => k.keyword === w)!;

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoSerpResult.deleteMany({ where: { tenantId: null, domain: DOMAIN } });
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Diag', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Diag', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'local', brandTerms: ['guardalo'] });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    const [primary, old] = await withAdminDb((db) =>
      Promise.all([
        db.seoProjectDomain.create({
          data: { projectId, domain: DOMAIN, role: 'primary', gscProperty: `sc-domain:${DOMAIN}` },
        }),
        db.seoProjectDomain.create({
          data: {
            projectId,
            domain: OLD_DOMAIN,
            role: 'redirect',
            gscProperty: `sc-domain:${OLD_DOMAIN}`,
          },
        }),
      ]),
    );
    domainId = primary.id;

    const rows: Row[] = [];
    const site = (dId: string) =>
      range(0, 99).map(
        (k): Row => ({
          tenantId: null,
          domainId: dId,
          grain: 'site',
          date: day(k),
          query: '',
          page: '',
          device: '',
          country: '',
          clicks: 10,
          impressions: 500,
          ctr: 0.02,
          position: 10,
        }),
      );
    rows.push(...site(domainId), ...site(old.id));
    // K1: dos páginas que se alternan cada día (conflicto, gravedad alta).
    rows.push(
      ...seedDays(
        domainId,
        'trasteros valencia',
        range(0, 19).map((o) => ({
          offset: o,
          pages: [
            { page: URL('/a'), impressions: o % 2 ? 10 : 4, clicks: 1 },
            { page: URL('/b'), impressions: o % 2 ? 4 : 10, clicks: 1 },
          ],
        })),
      ),
    );
    // K2: una sola página, la objetivo.
    rows.push(
      ...seedDays(
        domainId,
        'guardamuebles valencia',
        range(0, 9).map((o) => ({
          offset: o,
          pages: [{ page: URL('/precios'), impressions: 30, clicks: 3 }],
        })),
      ),
    );
    // K3: Google enseña otra página.
    rows.push(
      ...seedDays(
        domainId,
        'trasteros baratos',
        range(0, 9).map((o) => ({
          offset: o,
          pages: [{ page: URL('/otra'), impressions: 20, clicks: 1 }],
        })),
      ),
    );
    // K5: sin URL objetivo; Google pasó del blog a /alquiler y se quedó (cambio de página).
    rows.push(
      ...seedDays(
        domainId,
        'alquiler trastero',
        range(0, 13).map((o) => ({
          offset: o,
          pages:
            o >= 7
              ? [
                  { page: URL('/blog/x'), impressions: 15, clicks: 1 },
                  { page: URL('/alquiler'), impressions: 5, clicks: 2 },
                ]
              : [
                  { page: URL('/alquiler'), impressions: 20, clicks: 2 },
                  { page: URL('/blog/x'), impressions: 3, clicks: 1 },
                ],
        })),
        9,
      ),
    );
    // K6: la URL objetivo y la portada con poco (caso esperado, gravedad baja).
    rows.push(
      ...seedDays(
        domainId,
        'trasteros mislata centro',
        range(0, 9).map((o) => ({
          offset: o,
          pages: [
            { page: URL('/mislata'), impressions: 30, clicks: 3 },
            { page: `https://www.${DOMAIN}/`, impressions: 4, clicks: 0 },
          ],
        })),
      ),
    );
    // Marca: se reparten, pero no cuenta.
    rows.push(
      ...seedDays(
        domainId,
        'guardalo trasteros',
        range(0, 9).map((o) => ({
          offset: o,
          pages: [
            { page: URL('/a'), impressions: o % 2 ? 30 : 5, clicks: 1 },
            { page: URL('/b'), impressions: o % 2 ? 5 : 30, clicks: 1 },
          ],
        })),
      ),
    );
    // Búsquedas para el alta desde Search Console.
    rows.push(
      ...seedDays(
        domainId,
        'trastero pequeno valencia',
        range(0, 3).map((o) => ({
          offset: o,
          pages: [{ page: URL('/pequenos'), impressions: 25, clicks: 1 }],
        })),
        12,
      ),
    );
    // Dispositivo y país de K5.
    for (const [device, impressions] of [
      ['MOBILE', 200],
      ['DESKTOP', 100],
    ] as const) {
      rows.push({
        tenantId: null,
        domainId,
        grain: 'query_device',
        date: day(1),
        query: 'alquiler trastero',
        page: '',
        device,
        country: '',
        clicks: 5,
        impressions,
        ctr: 0,
        position: 9,
      });
    }
    rows.push({
      tenantId: null,
      domainId,
      grain: 'query_country',
      date: day(1),
      query: 'alquiler trastero',
      page: '',
      device: '',
      country: 'esp',
      clicks: 5,
      impressions: 300,
      ctr: 0,
      position: 9,
    });
    // Páginas (cruce `page`) para la indexación.
    const page = (dId: string, p: string, impressions: number): Row => ({
      tenantId: null,
      domainId: dId,
      grain: 'page',
      date: day(5),
      query: '',
      page: p,
      device: '',
      country: '',
      clicks: 1,
      impressions,
      ctr: 0,
      position: 8,
    });
    rows.push(
      page(domainId, URL('/portal/facturas'), 30),
      page(domainId, URL('/login'), 12),
      page(domainId, URL('/precios'), 300),
      page(domainId, `http://www.${DOMAIN}/precios/`, 15),
      page(domainId, URL('/blog'), 40),
      page(old.id, `https://${OLD_DOMAIN}/`, 9),
    );
    await withAdminDb((db) => db.seoGscMetric.createMany({ data: rows }));

    // Catálogo: K1–K6 con sus URL objetivo.
    const add = await http()
      .post(kw())
      .set(asSuper())
      .send({
        keywords: [
          'trasteros valencia',
          'guardamuebles valencia',
          'trasteros baratos',
          'trasteros mislata',
          'alquiler trastero',
          'trasteros mislata centro',
        ],
      });
    expect(add.status).toBe(201);
    const ids = new Map<string, string>(
      (add.body as { id: string; keyword: string }[]).map((k) => [k.keyword, k.id]),
    );
    const target = async (word: string, targetUrl: string, extra: object = {}) =>
      expect(
        (
          await http()
            .patch(`${kw()}/${ids.get(word)}`)
            .set(asSuper())
            .send({ targetUrl, ...extra })
        ).status,
      ).toBe(200);
    await target('trasteros valencia', `https://www.${DOMAIN}/a/`, { notes: 'mía' });
    await target('guardamuebles valencia', URL('/precios'));
    await target('trasteros baratos', URL('/ofertas'), { strategyLocked: true });
    await target('trasteros mislata', URL('/mislata'));
    await target('trasteros mislata centro', URL('/mislata'));

    // Posición estimada de SISTRIX de K5 (serie aparte).
    const k5 = await withAdminDb((db) =>
      db.seoProjectKeyword.findUniqueOrThrow({ where: { id: ids.get('alquiler trastero')! } }),
    );
    await withAdminDb((db) =>
      db.seoSerpResult.create({
        data: {
          tenantId: null,
          keywordId: k5.keywordId,
          country: 'es',
          provider: 'sistrix_mcp',
          sampleDate: day(2),
          position: 7,
          domain: DOMAIN,
          url: URL('/alquiler'),
        },
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('palabras seguidas: URL objetivo en sus cuatro estados, sugerencia y evolución diaria', async () => {
    const list = await tracked();
    expect(byWord(list, 'trasteros valencia')).toMatchObject({
      targetStatus: 'split',
      clicks: 40,
      impressions: 280,
    });
    expect(byWord(list, 'guardamuebles valencia')).toMatchObject({
      targetStatus: 'ok',
      googlePage: URL('/precios'),
    });
    expect(byWord(list, 'trasteros baratos')).toMatchObject({
      targetStatus: 'other_page',
      googlePage: URL('/otra'),
    });
    expect(byWord(list, 'trasteros mislata').targetStatus).toBe('none');
    const k5 = byWord(list, 'alquiler trastero');
    expect(k5).toMatchObject({ targetStatus: 'no_target', suggestedUrl: URL('/alquiler') });
    // La intención se deduce del texto si no hay otra.
    expect(k5).toMatchObject({ intent: 'do', intentSource: 'rules' });

    const res = await http()
      .get(`${base()}/tracked-keywords`)
      .query({ days: '28' })
      .set(asSupport());
    expect(res.body.targetSummary).toMatchObject({
      ok: 2,
      other_page: 1,
      split: 1,
      none: 1,
      no_target: 1,
    });
    expect(res.body.comparable).toBe(true);
    expect(res.body.byIntent.length).toBeGreaterThan(0);

    // Ficha: evolución diaria con el cambio de página, dispositivos, países y SISTRIX aparte.
    const detail = await http()
      .get(`${base()}/tracked-keywords/${k5.id}`)
      .query({ days: '28' })
      .set(asSupport());
    expect(detail.status).toBe(200);
    expect(detail.body.daily).toHaveLength(28);
    expect(detail.body.pageChanges).toEqual([
      { date: shiftDate(LAST, -6), from: URL('/blog/x'), to: URL('/alquiler') },
    ]);
    expect(detail.body.pages[0]).toMatchObject({ page: URL('/alquiler'), impressions: 175 });
    expect(detail.body.devices.map((d: { device: string }) => d.device)).toEqual([
      'MOBILE',
      'DESKTOP',
    ]);
    expect(detail.body.countries[0]).toMatchObject({ country: 'esp', impressions: 300 });
    expect(detail.body.sistrix.points).toEqual([
      { date: shiftDate(LAST, -2), position: 7, url: URL('/alquiler'), provider: 'sistrix_mcp' },
    ]);

    // Aceptar la URL propuesta (un clic: PATCH de la palabra).
    expect(
      (await http().patch(`${kw()}/${k5.id}`).set(asSupport()).send({ targetUrl: k5.suggestedUrl }))
        .status,
    ).toBe(403);
    await http().patch(`${kw()}/${k5.id}`).set(asSuper()).send({ targetUrl: k5.suggestedUrl });
    expect(byWord(await tracked(), 'alquiler trastero').targetStatus).toBe('split');

    const csv = await http().get(`${base()}/tracked-keywords/csv`).set(asSupport());
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Palabra;Grupo;');
    expect(csv.text).toContain('Google enseña otra página');
  });

  it('alta de palabras desde Search Console', async () => {
    const res = await http()
      .get(`${base()}/keyword-candidates`)
      .query({ days: '28' })
      .set(asSuper());
    expect(res.status).toBe(200);
    const queries = (res.body.items as { query: string }[]).map((c) => c.query);
    expect(queries).toContain('trastero pequeno valencia');
    // Sin la marca ni las ya seguidas, por defecto.
    expect(queries).not.toContain('guardalo trasteros');
    expect(queries).not.toContain('trasteros valencia');
    const withBrand = await http()
      .get(`${base()}/keyword-candidates`)
      .query({ excludeBrand: '0', excludeTracked: '0', minImpressions: '1' })
      .set(asSuper());
    const brand = (withBrand.body.items as { query: string; brand: boolean; tracked: boolean }[])
      .filter((c) => c.query === 'guardalo trasteros' || c.query === 'trasteros valencia')
      .map((c) => [c.query, c.brand, c.tracked]);
    expect(brand).toEqual(
      expect.arrayContaining([
        ['guardalo trasteros', true, false],
        ['trasteros valencia', false, true],
      ]),
    );

    const add = await http()
      .post(kw())
      .set(asSuper())
      .send({
        keywords: ['trastero pequeno valencia'],
        source: 'search_console',
        groupName: 'Valencia',
        priority: 1,
        intent: 'visit',
      });
    expect(add.status).toBe(201);
    expect(byWord(await tracked(), 'trastero pequeno valencia')).toMatchObject({
      source: 'search_console',
      groupName: 'Valencia',
      intent: 'visit',
      intentSource: 'manual',
    });
  });

  it('alta desde CSV: vista previa, sin pisar notas ni decisiones fijadas', async () => {
    const csv = [
      'Palabra;Grupo;Intención;URL objetivo;Prioridad;Notas',
      'trasteros valencia;Valencia;comercial;https://otra.es/x;alta;otra nota',
      'trasteros baratos;Ofertas;;;;',
      'nueva palabra csv;Nuevas;informativa;https://e2e-diagnostico.es/nueva;baja;',
      'x;;;;;',
      'otra palabra;;rara;;;',
    ].join('\n');
    expect(
      (
        await http()
          .post(`${base()}/keyword-import/preview`)
          .set(asSupport())
          .send({ content: csv })
      ).status,
    ).toBe(403);
    const preview = await http()
      .post(`${base()}/keyword-import/preview`)
      .set(asSuper())
      .send({ content: csv });
    expect(preview.status).toBe(201);
    expect(preview.body.counts).toEqual({
      create: 1,
      update: 1,
      unchanged: 0,
      locked: 1,
      error: 2,
    });
    expect(preview.body.overLimit).toBe(false);
    const upd = (preview.body.items as { keyword: string; changes: string[] }[]).find(
      (i) => i.keyword === 'trasteros valencia',
    )!;
    expect(upd.changes).toEqual(['groupName', 'intent']);

    const noColumn = await http()
      .post(`${base()}/keyword-import/preview`)
      .set(asSuper())
      .send({ content: 'grupo\nA' });
    expect(noColumn.status).toBe(400);
    expect(noColumn.body.code).toBe('seo_import_no_keyword_column');

    const commit = await http()
      .post(`${base()}/keyword-import`)
      .set(asSuper())
      .send({ content: csv });
    expect(commit.status).toBe(201);
    expect(commit.body).toMatchObject({ created: 1, updated: 1, locked: 1, errors: 2 });
    const list = await tracked();
    expect(byWord(list, 'trasteros valencia')).toMatchObject({
      groupName: 'Valencia',
      intent: 'do',
      notes: 'mía',
    });
    expect(byWord(list, 'trasteros baratos').groupName).toBeNull();
    expect(byWord(list, 'nueva palabra csv')).toMatchObject({
      source: 'import',
      groupName: 'Nuevas',
      intent: 'know',
    });
  });

  it('canibalización: gravedad, tipos, estado y vuelta tras darla por arreglada', async () => {
    expect((await http().post(`${base()}/recalculate`).set(asSupport())).status).toBe(403);
    const calc = await http().post(`${base()}/recalculate`).set(asSuper());
    expect(calc.status).toBe(201);

    const res = await http().get(`${base()}/cannibalization`).set(asSupport());
    expect(res.status).toBe(200);
    type C = {
      id: string;
      query: string;
      severity: string;
      kind: string;
      expected: boolean;
      status: string;
      pages: { page: string; isTarget: boolean; isHome: boolean }[];
      timeline: { date: string; page: string }[];
      returnedAt: string | null;
    };
    const items = res.body.items as C[];
    const q = (query: string) => items.find((c) => c.query === query);
    expect(q('trasteros valencia')).toMatchObject({ severity: 'high', kind: 'conflict' });
    expect(q('trasteros valencia')!.timeline).toHaveLength(20);
    expect(q('alquiler trastero')).toMatchObject({ kind: 'switch' });
    expect(q('trasteros mislata centro')).toMatchObject({ severity: 'low', expected: true });
    expect(q('trasteros mislata centro')!.pages.find((p) => p.isHome)).toBeTruthy();
    expect(q('guardalo trasteros')).toBeUndefined();
    expect(q('guardamuebles valencia')).toBeUndefined();
    // La más grave, primero.
    expect(items[0]!.severity).toBe('high');

    const summary = await http().get(`${base()}/cannibalization/summary`).set(asSupport());
    expect(summary.body.open).toBe(items.length);
    expect(summary.body.bySeverity.high).toBe(1);

    const k1 = q('trasteros valencia')!;
    expect(
      (
        await http()
          .patch(`${base()}/cannibalization/${k1.id}`)
          .set(asSupport())
          .send({ status: 'fixed' })
      ).status,
    ).toBe(403);
    const fixed = await http()
      .patch(`${base()}/cannibalization/${k1.id}`)
      .set(asSuper())
      .send({ status: 'fixed', notes: 'Unificadas /a y /b' });
    expect(fixed.body).toMatchObject({ status: 'fixed', notes: 'Unificadas /a y /b' });

    // Recalcular no pisa: Google no lo ha enseñado después de arreglarlo.
    await http().post(`${base()}/recalculate`).set(asSuper());
    const kept = await http()
      .get(`${base()}/cannibalization`)
      .query({ status: 'fixed' })
      .set(asSuper());
    expect(kept.body.items[0]).toMatchObject({
      id: k1.id,
      status: 'fixed',
      notes: 'Unificadas /a y /b',
    });

    // Se dio por arreglada hace 40 días (pasado el margen de 28) y Google lo sigue enseñando: vuelve.
    await withAdminDb((db) =>
      db.seoCannibalization.update({
        where: { id: k1.id },
        data: { resolvedAt: new Date(Date.now() - 40 * 86_400_000) },
      }),
    );
    await http().post(`${base()}/recalculate`).set(asSuper());
    const back = (await http().get(`${base()}/cannibalization`).set(asSuper())).body.items.find(
      (c: C) => c.id === k1.id,
    );
    expect(back).toMatchObject({ status: 'new', notes: 'Unificadas /a y /b' });
    expect(back.returnedAt).toBeTruthy();

    // Umbrales: con la segunda página al 45 % el caso esperado ya no es una canibalización.
    const saved = await http()
      .put(`${base()}/settings`)
      .set(asSuper())
      .send({ cannibalization: { minSecondShare: 0.45 } });
    expect(saved.status).toBe(200);
    const after = (await http().get(`${base()}/cannibalization`).set(asSuper())).body.items as C[];
    expect(after.map((c) => c.query)).toEqual(['trasteros valencia']);

    const csv = await http().get(`${base()}/cannibalization/csv`).set(asSupport());
    expect(csv.text).toContain('Búsqueda;Dominio;Gravedad');
    expect(csv.text).toContain('Probable conflicto');
    await http().put(`${base()}/settings`).set(asSuper()).send({ reset: true });
  });

  it('indexación: reglas por defecto y editadas, variantes y dominio redirigido', async () => {
    await http().post(`${base()}/recalculate`).set(asSuper());
    type F = { id: string; url: string; category: string; rule: string; evidence: string };
    const list = async (query: Record<string, string> = {}) =>
      (await http().get(`${base()}/index-findings`).query(query).set(asSupport())).body
        .items as F[];
    const found = await list();
    expect(found.map((f) => [f.url, f.category]).sort()).toEqual(
      [
        [URL('/login'), 'login'],
        [URL('/portal/facturas'), 'private'],
        [`http://www.${DOMAIN}/precios/`, 'duplicate'],
        [`https://${OLD_DOMAIN}/`, 'redirect_domain'],
      ].sort(),
    );
    expect(found.every((f) => f.evidence === 'performance')).toBe(true);

    const settings = await http().get(`${base()}/settings`).set(asSupport());
    expect(settings.body.indexRules).toContain('/portal');
    expect(settings.body.customIndexRules).toBe(false);
    expect(
      (
        await http()
          .put(`${base()}/settings`)
          .set(asSupport())
          .send({ indexRules: ['/blog'] })
      ).status,
    ).toBe(403);
    const saved = await http()
      .put(`${base()}/settings`)
      .set(asSuper())
      .send({ indexRules: ['/blog'] });
    expect(saved.body).toMatchObject({ indexRules: ['/blog'], customIndexRules: true });
    const edited = await list();
    expect(edited.map((f) => f.category).sort()).toEqual(
      ['custom', 'duplicate', 'redirect_domain'].sort(),
    );

    const blog = edited.find((f) => f.category === 'custom')!;
    const ok = await http()
      .patch(`${base()}/index-findings/${blog.id}`)
      .set(asSuper())
      .send({ status: 'ok', notes: 'El blog sí debe salir' });
    expect(ok.body.status).toBe('ok');
    expect((await list()).some((f) => f.id === blog.id)).toBe(false);
    expect((await list({ status: 'ok' })).map((f) => f.id)).toEqual([blog.id]);

    const summary = await http().get(`${base()}/index-findings/summary`).set(asSupport());
    expect(summary.body.byCategory).toMatchObject({ duplicate: 1, redirect_domain: 1, custom: 0 });

    const csv = await http().get(`${base()}/index-findings/csv`).set(asSupport());
    expect(csv.text).toContain('Aparece en el rendimiento de Search Console');

    // Mapas del sitio: solo lo que da la API de Search Console (simulada).
    const pending = await http().get(`${base()}/index-findings/sitemaps`).set(asSupport());
    const pendingPrimary = pending.body.domains.find(
      (d: { domainId: string }) => d.domainId === domainId,
    );
    expect(pendingPrimary.error).toBeTruthy();
    await withAdminDb((db) =>
      db.seoProjectDomain.update({
        where: { id: domainId },
        data: { connectionStatus: 'connected' },
      }),
    );
    const maps = await http().get(`${base()}/index-findings/sitemaps`).set(asSupport());
    const primary = maps.body.domains.find((d: { domainId: string }) => d.domainId === domainId);
    expect(primary).toMatchObject({ error: null });
    expect(primary.sitemaps[0]).toMatchObject({ submitted: 42, errors: 0 });

    const reset = await http().put(`${base()}/settings`).set(asSuper()).send({ reset: true });
    expect(reset.body.customIndexRules).toBe(false);
  });

  it('tenant: su diagnóstico tras la descarga, el límite de palabras y aislado de los demás', async () => {
    const owner = await registerVerifiedUser(app, 'seodiaga');
    const other = await registerVerifiedUser(app, 'seodiagb');
    tenantIds.push(owner.tenantId, other.tenantId);
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    expect(project.status).toBe(201);
    const tenantProject = project.body.id as string;

    // La carga inicial (simulada) termina y engancha el diagnóstico.
    let calculated: Date | null = null;
    for (let i = 0; i < 200 && !calculated; i++) {
      calculated = await withAdminDb(
        async (db) =>
          (await db.seoProject.findUniqueOrThrow({ where: { id: tenantProject } }))
            .diagnosticsCalculatedAt,
      );
      if (!calculated) await new Promise((r) => setTimeout(r, 250));
    }
    expect(calculated).toBeTruthy();

    const mine = await http().get('/seo-advanced/diagnostics/tracked-keywords').set(a);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ items: [], limit: 300 });
    expect(
      (await http().get('/seo-advanced/diagnostics/cannibalization/summary').set(a)).status,
    ).toBe(200);
    expect((await http().get('/seo-advanced/diagnostics/index-findings').set(a)).status).toBe(200);

    // Sin el extra, no.
    expect((await http().get('/seo-advanced/diagnostics/tracked-keywords').set(b)).status).toBe(
      403,
    );
    // Ni lo de la plataforma: ni por el admin ni por id.
    expect((await http().get(`${base()}/tracked-keywords`).set(a)).status).toBe(401);
    const platformItem = (await http().get(`${base()}/cannibalization`).set(asSuper())).body
      .items[0] as { id: string };
    expect(
      (
        await http()
          .patch(`/seo-advanced/diagnostics/cannibalization/${platformItem.id}`)
          .set(a)
          .send({ status: 'ok' })
      ).status,
    ).toBe(404);

    // El soporte lee el proyecto del tenant; el super admin no lo cambia.
    const tBase = `/admin/seo/projects/${tenantProject}/diagnostics`;
    expect((await http().get(`${tBase}/tracked-keywords`).set(asSupport())).status).toBe(200);
    expect(
      (
        await http()
          .put(`${tBase}/settings`)
          .set(asSuper())
          .send({ indexRules: ['/x'] })
      ).status,
    ).toBe(404);

    // Límite de 300 palabras: con 299, un fichero con dos nuevas no cabe.
    await withAdminDb(async (db) => {
      const words = range(1, 299).map((n) => `palabra limite ${n}`);
      await db.seoKeyword.createMany({
        data: words.map((keyword) => ({ keyword, country: 'ES', language: 'es' })),
        skipDuplicates: true,
      });
      const ids = await db.seoKeyword.findMany({
        where: { keyword: { in: words }, country: 'ES', language: 'es' },
        select: { id: true },
      });
      await db.seoProjectKeyword.createMany({
        data: ids.map((k) => ({
          tenantId: owner.tenantId,
          projectId: tenantProject,
          keywordId: k.id,
        })),
      });
    });
    const csv = 'keyword\nprimera nueva\nsegunda nueva';
    const preview = await http()
      .post('/seo-advanced/diagnostics/keyword-import/preview')
      .set(a)
      .send({ content: csv });
    expect(preview.body).toMatchObject({ current: 299, limit: 300, overLimit: true });
    const commit = await http()
      .post('/seo-advanced/diagnostics/keyword-import')
      .set(a)
      .send({ content: csv });
    expect(commit.status).toBe(409);
    expect(commit.body.code).toBe('seo_keyword_limit');
  });
});
