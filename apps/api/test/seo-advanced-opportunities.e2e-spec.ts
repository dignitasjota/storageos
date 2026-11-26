import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { PrismaService } from '../src/modules/database/prisma.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-opp-super@storageos.local';
const SUPPORT_EMAIL = 'seo-opp-support@storageos.local';
const PREFIX = 'E2E oportunidades ';
const DOMAIN = 'e2e-oportunidades.es';
const COMPETITOR = 'competidor-oportunidades.es';

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

type Period = { impressions: number; clicks: number; position: number };

/** Una búsqueda: lo del periodo en dos días y, si se da, lo del periodo anterior. */
async function seedQuery(input: {
  domainId: string;
  tenantId: string | null;
  query: string;
  current: Period;
  previous?: Period;
  page?: string;
  offsets?: [number, number];
}): Promise<void> {
  const rows: {
    tenantId: string | null;
    domainId: string;
    grain: string;
    date: Date;
    query: string;
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[] = [];
  const put = (p: Period, offsets: [number, number]) => {
    const half = (n: number, k: number) => (k === 0 ? Math.ceil(n / 2) : Math.floor(n / 2));
    offsets.forEach((o, k) => {
      const impressions = half(p.impressions, k);
      const clicks = half(p.clicks, k);
      const base = {
        tenantId: input.tenantId,
        domainId: input.domainId,
        date: day(o),
        query: input.query,
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: p.position,
      };
      rows.push({ ...base, grain: 'query', page: '' });
      if (input.page) rows.push({ ...base, grain: 'query_page', page: input.page });
    });
  };
  put(input.current, input.offsets ?? [1, 5]);
  if (input.previous) put(input.previous, [32, 40]);
  await withAdminDb((db) => db.seoGscMetric.createMany({ data: rows }));
}

/** Lo de SISTRIX sembrado en la plataforma por estas pruebas. */
async function cleanupSistrix(): Promise<void> {
  await withAdminDb(async (db) => {
    await db.seoDomainOpportunity.deleteMany({ where: { domain: DOMAIN } });
    await db.seoDomainKeyword.deleteMany({ where: { domain: COMPETITOR } });
    await db.seoKeywordMetric.deleteMany({
      where: { tenantId: null, keyword: { keyword: { in: ['trasteros benimamet'] } } },
    });
  });
}

describe('SEO Avanzado: motor de oportunidades (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  let superId = '';
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let projectId = '';
  const base = () => `/admin/seo/projects/${projectId}/opportunity-engine`;

  type Opp = {
    id: string;
    type: string;
    query: string;
    score: number;
    status: string;
    sources: string[];
    notes: string | null;
    returnedAt: string | null;
    assignedToId: string | null;
    assignedToName: string | null;
    metrics: Record<string, unknown>;
    factors: { key: string; points: number }[];
  };
  const listAll = async (query: Record<string, string> = {}): Promise<Opp[]> => {
    const res = await http()
      .get(base())
      .query({ limit: '200', ...query })
      .set(asSuper());
    expect(res.status).toBe(200);
    return res.body.items as Opp[];
  };
  const find = (list: Opp[], type: string, query: string) =>
    list.find((o) => o.type === type && o.query === query);

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupSistrix();
    await withAdminDb((db) =>
      db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } }),
    );
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
      superId = (
        await db.superAdmin.create({
          data: {
            email: SUPER_EMAIL,
            passwordHash,
            fullName: 'Super Oportunidades',
            role: 'superadmin',
          },
        })
      ).id;
      await db.superAdmin.create({
        data: {
          email: SUPPORT_EMAIL,
          passwordHash,
          fullName: 'Soporte Oportunidades',
          role: 'support',
        },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    // Proyecto de la plataforma con su dominio y 60 días de datos (sin descarga).
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'local', brandTerms: ['guardalo'] });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    const domain = await withAdminDb((db) =>
      db.seoProjectDomain.create({
        data: { projectId, domain: DOMAIN, role: 'primary', gscProperty: `sc-domain:${DOMAIN}` },
      }),
    );
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: Array.from({ length: 60 }, (_, k) => ({
          domainId: domain.id,
          grain: 'site',
          date: day(k),
          clicks: 10,
          impressions: 500,
          ctr: 0.02,
          position: 10,
        })),
      }),
    );
    const q = (query: string, current: Period, previous?: Period, page?: string) =>
      seedQuery({
        domainId: domain.id,
        tenantId: null,
        query,
        current,
        ...(previous ? { previous } : {}),
        ...(page ? { page } : {}),
      });
    await q(
      'trasteros valencia precio',
      { impressions: 400, clicks: 20, position: 6 },
      undefined,
      `https://${DOMAIN}/precios`,
    );
    await q('guardamuebles valencia', { impressions: 300, clicks: 6, position: 14 });
    await q('alquilar trastero barato', { impressions: 40, clicks: 0, position: 30 });
    await q('que es un trastero', { impressions: 40, clicks: 0, position: 35 });
    await q('trasteros cerca de mi', { impressions: 2000, clicks: 5, position: 3 });
    await q(
      'boxes valencia',
      { impressions: 100, clicks: 5, position: 8 },
      { impressions: 60, clicks: 1, position: 18 },
    );
    await q(
      'trasteros mislata',
      { impressions: 120, clicks: 2, position: 12 },
      { impressions: 140, clicks: 10, position: 4 },
    );
    await q('guardalo trasteros', { impressions: 500, clicks: 100, position: 5 });
    await q('trasteros benimamet', { impressions: 60, clicks: 1, position: 30 });

    // Tus palabras: una con métricas de SISTRIX sin volumen (demanda local).
    const kw = await http()
      .post(`/admin/seo/projects/${projectId}/keywords`)
      .set(asSuper())
      .send({ keywords: ['trasteros benimamet'], priority: 1 });
    expect(kw.status).toBe(201);
    const keywordId = await withAdminDb(
      async (db) =>
        (await db.seoKeyword.findFirstOrThrow({ where: { keyword: 'trasteros benimamet' } })).id,
    );
    const fetchedAt = new Date();
    await withAdminDb(async (db) => {
      await db.seoKeywordMetric.create({
        data: {
          keywordId,
          country: 'es',
          provider: 'sistrix_mcp',
          traffic: 0,
          competition: 10,
          intentVisit: 80,
          intentKnow: 10,
          dataDate: day(7),
          fetchedAt,
        },
      });
      // Oportunidades de SISTRIX de tu dominio (una coincide con una propia).
      await db.seoDomainOpportunity.createMany({
        data: [
          {
            keyword: 'trasteros valencia precio',
            position: 7,
            gain: 120,
            competition: 40,
            traffic: 900,
          },
          {
            keyword: 'mini almacen valencia',
            position: 15,
            gain: 80,
            competition: 30,
            traffic: 600,
          },
        ].map((r) => ({
          ...r,
          domain: DOMAIN,
          country: 'es',
          provider: 'sistrix_mcp',
          kind: 'opportunity',
          sampleDate: day(7),
          fetchedAt,
          url: `https://${DOMAIN}/`,
        })),
      });
      // Un competidor seguido y sus palabras.
      await db.seoCompetitor.create({ data: { projectId, domain: COMPETITOR } });
      await db.seoDomainKeyword.createMany({
        data: [
          { keyword: 'almacenaje valencia', position: 5 },
          { keyword: 'trasteros valencia precio', position: 2 },
          { keyword: 'lejos de todo', position: 35 },
        ].map((r) => ({
          ...r,
          domain: COMPETITOR,
          country: 'es',
          provider: 'sistrix_mcp',
          sampleDate: day(7),
          fetchedAt,
          url: `https://${COMPETITOR}/`,
        })),
      });
    });
  });

  afterAll(async () => {
    await app.close();
    await withAdminDb((db) =>
      db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } }),
    );
    await cleanupSistrix();
    await withAdminDb((db) =>
      db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } }),
    );
    await cleanupTestTenants();
  });

  it('genera las de cada tipo, sin las de marca, y fusiona las de SISTRIX', async () => {
    // El soporte solo lee.
    expect((await http().post(`${base()}/recalculate`).set(asSupport())).status).toBe(403);
    const calc = await http().post(`${base()}/recalculate`).set(asSuper());
    expect(calc.status).toBe(201);
    expect(calc.body.detected).toBeGreaterThan(5);
    expect(calc.body.created).toBe(calc.body.detected);

    const list = await listAll();
    expect(find(list, 'near_top3', 'trasteros valencia precio')).toBeTruthy();
    expect(find(list, 'near_page1', 'guardamuebles valencia')).toBeTruthy();
    expect(find(list, 'commercial_deep', 'alquilar trastero barato')).toBeTruthy();
    expect(list.some((o) => o.query === 'que es un trastero')).toBe(false);
    expect(find(list, 'low_ctr', 'trasteros cerca de mi')).toBeTruthy();
    expect(find(list, 'rising', 'boxes valencia')).toBeTruthy();
    expect(find(list, 'falling', 'trasteros mislata')).toBeTruthy();
    expect(list.some((o) => o.query === 'guardalo trasteros')).toBe(false);
    const gap = find(list, 'demand_gap', 'trasteros benimamet')!;
    expect(gap.metrics).toMatchObject({
      demandVariant: 'unseen_by_sistrix',
      inCatalog: true,
      priority: 1,
    });

    // Fusión: la propia lleva los dos orígenes y no hay otra de SISTRIX para la misma búsqueda.
    const merged = find(list, 'near_top3', 'trasteros valencia precio')!;
    expect(merged.sources).toEqual(['gsc', 'sistrix']);
    expect(merged.metrics).toMatchObject({ sistrix: { gain: 120, provider: 'sistrix_mcp' } });
    expect(find(list, 'sistrix', 'trasteros valencia precio')).toBeUndefined();
    expect(find(list, 'sistrix', 'mini almacen valencia')!.sources).toEqual(['sistrix']);

    // La competencia sale y tú no (las que ya tienes y las de más abajo, fuera).
    const kgap = find(list, 'keyword_gap', 'almacenaje valencia')!;
    expect(kgap.metrics).toMatchObject({ competitors: [{ domain: COMPETITOR, position: 5 }] });
    expect(list.filter((o) => o.type === 'keyword_gap')).toHaveLength(1);

    // Ordenadas por puntuación, con desglose y página que más clics recibe.
    const scores = list.map((o) => o.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(merged.factors.map((f) => f.key)).toContain('difficulty');

    const detail = await http().get(`${base()}/${merged.id}`).set(asSupport());
    expect(detail.status).toBe(200);
    expect(detail.body.page).toBe(`https://${DOMAIN}/precios`);
    expect(detail.body.pages[0]).toMatchObject({
      page: `https://${DOMAIN}/precios`,
      impressions: 400,
    });
    expect(detail.body.daily.length).toBe(90);
    expect(
      detail.body.daily.reduce((s: number, d: { impressions: number }) => s + d.impressions, 0),
    ).toBe(400);

    const summary = await http().get(`${base()}/summary`).set(asSupport());
    expect(summary.body.byType.near_top3).toBeGreaterThanOrEqual(2);
    expect(summary.body.byStatus.new).toBe(list.length);
    expect(summary.body.top).toHaveLength(5);
    expect(summary.body.calculatedAt).toBeTruthy();
  });

  it('recalcular no pisa estado, notas ni asignación; una descartada vuelve si sube mucho', async () => {
    let list = await listAll();
    const target = find(list, 'near_page1', 'guardamuebles valencia')!;
    const toDismiss = find(list, 'commercial_deep', 'alquilar trastero barato')!;

    expect(
      (await http().patch(`${base()}/${target.id}`).set(asSupport()).send({ status: 'seen' }))
        .status,
    ).toBe(403);
    const assignees = await http().get(`${base()}/assignees`).set(asSuper());
    expect(assignees.body.map((a: { id: string }) => a.id)).toContain(superId);
    const upd = await http()
      .patch(`${base()}/${target.id}`)
      .set(asSuper())
      .send({ status: 'in_progress', notes: 'Reescribir la ficha', assignedToId: superId });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({
      status: 'in_progress',
      notes: 'Reescribir la ficha',
      assignedToName: 'Super Oportunidades',
    });

    // Descartar exige motivo.
    const noReason = await http()
      .patch(`${base()}/${toDismiss.id}`)
      .set(asSuper())
      .send({ status: 'dismissed' });
    expect(noReason.status).toBe(400);
    const dismissed = await http()
      .patch(`${base()}/${toDismiss.id}`)
      .set(asSuper())
      .send({ status: 'dismissed', dismissReason: 'No ofrecemos trasteros baratos' });
    expect(dismissed.body).toMatchObject({ status: 'dismissed' });

    const again = await http().post(`${base()}/recalculate`).set(asSuper());
    expect(again.body.created).toBe(0);
    list = await listAll();
    expect(list.find((o) => o.id === target.id)).toMatchObject({
      status: 'in_progress',
      notes: 'Reescribir la ficha',
      assignedToId: superId,
    });
    // La descartada no sale por defecto, pero sí al pedirla.
    expect(list.some((o) => o.id === toDismiss.id)).toBe(false);
    const gone = await listAll({ status: 'dismissed' });
    expect(gone.find((o) => o.id === toDismiss.id)).toMatchObject({ status: 'dismissed' });

    // Si su puntuación sube lo bastante (aquí: se descartó con 25 puntos menos), vuelve como nueva.
    await withAdminDb((db) =>
      db.seoOpportunity.update({
        where: { id: toDismiss.id },
        data: { dismissedScore: toDismiss.score - 25 },
      }),
    );
    const third = await http().post(`${base()}/recalculate`).set(asSuper());
    expect(third.body.returned).toBe(1);
    const back = (await listAll()).find((o) => o.id === toDismiss.id)!;
    expect(back.status).toBe('new');
    expect(back.returnedAt).toBeTruthy();
    const summary = await http().get(`${base()}/summary`).set(asSuper());
    expect(summary.body.returned).toBe(1);
  });

  it('filtros, orden, CSV y pesos del proyecto', async () => {
    const lowCtr = await listAll({ type: 'low_ctr' });
    expect(lowCtr.length).toBeGreaterThan(0);
    expect(lowCtr.every((o) => o.type === 'low_ctr')).toBe(true);
    const search = await listAll({ search: 'VALENCIA' });
    expect(search.every((o) => o.query.includes('valencia'))).toBe(true);
    const all = await listAll();
    const min = all[Math.floor(all.length / 2)]!.score;
    expect((await listAll({ minScore: String(min) })).every((o) => o.score >= min)).toBe(true);
    const paged = await http().get(base()).query({ limit: '2', offset: '0' }).set(asSuper());
    expect(paged.body).toMatchObject({ limit: 2, hasMore: true });
    expect(paged.body.total).toBe(all.length);

    const csv = await http().get(`${base()}/csv`).query({ type: 'low_ctr' }).set(asSupport());
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Puntuación;');
    expect(csv.text).toContain('trasteros cerca de mi');
    expect(csv.text).not.toContain('guardamuebles valencia');

    // Pesos: solo el CTR cuenta → la de poco clic sube.
    const before = find(all, 'low_ctr', 'trasteros cerca de mi')!.score;
    const settings = await http().get(`${base()}/settings`).set(asSupport());
    expect(settings.body.weights).toEqual(settings.body.defaults.weights);
    expect(
      (
        await http()
          .put(`${base()}/settings`)
          .set(asSupport())
          .send({ weights: { ctrGap: 1 } })
      ).status,
    ).toBe(403);
    const invalid = await http()
      .put(`${base()}/settings`)
      .set(asSuper())
      .send({
        weights: { impressions: 0, position: 0, ctrGap: 0, business: 0, priority: 0, trend: 0 },
      });
    expect(invalid.status).toBe(400);
    const saved = await http()
      .put(`${base()}/settings`)
      .set(asSuper())
      .send({
        weights: {
          impressions: 0,
          position: 0,
          ctrGap: 1,
          business: 0,
          priority: 0,
          trend: 0,
          difficulty: 0,
        },
        thresholds: { lowCtrMinImpressions: 150 },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.thresholds.lowCtrMinImpressions).toBe(150);
    const after = find(await listAll(), 'low_ctr', 'trasteros cerca de mi')!.score;
    expect(after).toBeGreaterThan(before);
    const reset = await http().put(`${base()}/settings`).set(asSuper()).send({ reset: true });
    expect(reset.body.weights).toEqual(reset.body.defaults.weights);
    expect(reset.body.thresholds).toEqual(reset.body.defaults.thresholds);
    expect(find(await listAll(), 'low_ctr', 'trasteros cerca de mi')!.score).toBe(before);
  });

  it('tenant: su proyecto se recalcula tras la descarga, aislado de los demás y del admin', async () => {
    const owner = await registerVerifiedUser(app, 'seoopportunitiesa');
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    expect(project.status).toBe(201);
    const tenantProject = project.body.id as string;
    const domainId = project.body.domains[0].id as string;

    // La carga inicial (simulada) termina y engancha el cálculo de oportunidades.
    let calculated: Date | null = null;
    for (let i = 0; i < 200 && !calculated; i++) {
      calculated = await withAdminDb(
        async (db) =>
          (await db.seoProject.findUniqueOrThrow({ where: { id: tenantProject } }))
            .opportunitiesCalculatedAt,
      );
      if (!calculated) await new Promise((r) => setTimeout(r, 250));
    }
    expect(calculated).toBeTruthy();

    const last = await withAdminDb(
      async (db) =>
        (
          await db.seoGscMetric.aggregate({
            where: { domainId, grain: 'site' },
            _max: { date: true },
          })
        )._max.date!,
    );
    const lastDay = last.toISOString().slice(0, 10);
    const rel = (o: number) =>
      Math.round(
        (Date.parse(`${LAST}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / 86_400_000,
      ) + o;
    await seedQuery({
      domainId,
      tenantId: owner.tenantId,
      query: 'guardamuebles exclusivo tenant',
      current: { impressions: 300, clicks: 3, position: 15 },
      offsets: [rel(1), rel(3)],
    });
    // El propietario recalcula a mano.
    const calc = await http().post('/seo-advanced/opportunity-engine/recalculate').set(a);
    expect(calc.status).toBe(201);
    const mine = await http()
      .get('/seo-advanced/opportunity-engine')
      .query({ limit: '200' })
      .set(a);
    expect(mine.status).toBe(200);
    const opp = mine.body.items.find(
      (o: { query: string }) => o.query === 'guardamuebles exclusivo tenant',
    );
    expect(opp).toMatchObject({ type: 'near_page1', status: 'new' });
    const patched = await http()
      .patch(`/seo-advanced/opportunity-engine/${opp.id}`)
      .set(a)
      .send({ status: 'done', assignedToId: owner.userId });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'done' });
    // A alguien de otro negocio, no.
    expect(
      (
        await http()
          .patch(`/seo-advanced/opportunity-engine/${opp.id}`)
          .set(a)
          .send({ assignedToId: superId })
      ).body.code,
    ).toBe('seo_assignee_invalid');

    // Otro tenant no ve nada de este (ni por la política de filas).
    const other = await registerVerifiedUser(app, 'seoopportunitiesb');
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(other.slug, 'seo_advanced', true);
    await http().post('/seo-advanced/project').set(b).send({});
    const theirs = await http()
      .get('/seo-advanced/opportunity-engine')
      .query({ status: 'new,seen,in_progress,done,dismissed' })
      .set(b);
    expect(theirs.body.items.some((o: { query: string }) => o.query.includes('exclusivo'))).toBe(
      false,
    );
    expect((await http().get(`/seo-advanced/opportunity-engine/${opp.id}`).set(b)).status).toBe(
      404,
    );
    const leaked = await app
      .get(PrismaService)
      .withTenant(
        (tx) => tx.seoOpportunity.count({ where: { tenantId: owner.tenantId } }),
        other.tenantId,
      );
    expect(leaked).toBe(0);

    // El admin lo lee; no lo cambia (los proyectos de los tenants, solo lectura).
    const adminRead = await http()
      .get(`/admin/seo/projects/${tenantProject}/opportunity-engine/${opp.id}`)
      .set(asSupport());
    expect(adminRead.status).toBe(200);
    expect(
      (
        await http()
          .patch(`/admin/seo/projects/${tenantProject}/opportunity-engine/${opp.id}`)
          .set(asSuper())
          .send({ status: 'seen' })
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${tenantProject}/opportunity-engine/recalculate`)
          .set(asSuper())
      ).status,
    ).toBe(404);
  });
});
