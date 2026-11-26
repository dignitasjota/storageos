import { hash as argonHash } from '@node-rs/argon2';
import { SEO_UNTRUSTED_OPEN, seoAiPromptKey, shiftDate } from '@storageos/shared';
import request from 'supertest';

import { AI_PROVIDER, type AiProvider, type AiRequest } from '../src/modules/ai/ai-provider';
import { SeoGa4Service } from '../src/modules/seo-advanced/ga4/seo-ga4.service';
import { SeoOpportunityEngineService } from '../src/modules/seo-advanced/opportunities/seo-opportunity-engine.service';
import { SeoAlertsService } from '../src/modules/seo-advanced/reports/seo-alerts.service';
import {
  normalizeSistrix,
  parseMcpResult,
  toMcpCall,
} from '../src/modules/seo-advanced/sistrix/sistrix-normalizer';
import { stubMcpResult } from '../src/modules/seo-advanced/sistrix/sistrix-stub-data';
import {
  SistrixSyncService,
  poolOfProject,
} from '../src/modules/seo-advanced/sistrix/sistrix-sync.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-ga4ai-super@storageos.local';
const SUPPORT_EMAIL = 'seo-ga4ai-support@storageos.local';
const PREFIX = 'E2E GA4 IA ';
const HOST = 'e2e-ga4-ia-seo.es';
const COMP = 'competidor-ga4-ia-e2e.es';
const BRAND = 'marca e2e ga4ia';
const KEYWORD = 'trasteros e2e ga4ia';
const LAST = shiftDate(new Date().toISOString().slice(0, 10), -3);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
/** Propiedades de GA4 distintas en cada ejecución (son únicas en la base de datos). */
const RUN = String(Date.now() % 100_000_000).padStart(8, '0');
const PLATFORM_PROPERTY = `7${RUN}`;
const MARKETING_PROPERTY = `8${RUN}`;
const OTHER_PROPERTY = `9${RUN}`;

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

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

/** Espera a que la descarga de GA4 del proyecto termine (la cola `seo`). */
async function waitGa4(projectId: string): Promise<string | null> {
  for (let i = 0; i < 240; i++) {
    const p = await withAdminDb((db) =>
      db.seoProject.findUniqueOrThrow({
        where: { id: projectId },
        select: { ga4Status: true, ga4InitialDoneAt: true },
      }),
    );
    if (p.ga4Status === 'error' || (p.ga4Status === 'connected' && p.ga4InitialDoneAt)) {
      return p.ga4Status;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('la descarga de GA4 no terminó');
}

/** Search Console: sitio, búsqueda, página y búsqueda + página («/precios» gana la búsqueda). */
function gscRows(tenantId: string | null, domainId: string, host: string): object[] {
  const rows: object[] = [];
  const row = (grain: string, date: string, extra: object) => ({
    tenantId,
    domainId,
    grain,
    date: asDate(date),
    query: '',
    page: '',
    device: '',
    country: '',
    ctr: 0,
    ...extra,
  });
  for (let n = 0; n < 60; n++) {
    const d = shiftDate(LAST, -n);
    rows.push(row('site', d, { clicks: 10, impressions: 400, position: 9 }));
    rows.push(row('query', d, { query: KEYWORD, clicks: 3, impressions: 120, position: 7 }));
    rows.push(
      row('page', d, { page: `https://${host}/precios`, clicks: 3, impressions: 150, position: 8 }),
    );
    rows.push(
      row('page', d, {
        page: `https://${host}/solo-google`,
        clicks: 1,
        impressions: 20,
        position: 15,
      }),
    );
    rows.push(
      row('query_page', d, {
        query: KEYWORD,
        page: `https://${host}/precios`,
        clicks: 3,
        impressions: 120,
        position: 7,
      }),
    );
  }
  return rows;
}

describe('SEO Avanzado: Google Analytics y visibilidad en IA (e2e, simulado)', () => {
  let app: INestApplication;
  let superToken = '';
  let supportToken = '';
  let owner: VerifiedUser;
  let other: VerifiedUser;
  let projectId = '';
  let tenantProject = '';
  let otherProject = '';
  const tenantIds: string[] = [];
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  const asOwner = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const asOther = () => ({ Authorization: `Bearer ${other.accessToken}` });
  const admin = () => `/admin/seo/projects/${projectId}`;

  /** Lo que es de esta suite y solo eso (la conexión de SISTRIX de la plataforma no se toca). */
  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.seoKeyword.deleteMany({ where: { keyword: KEYWORD } });
      const subjects = [HOST, COMP, BRAND];
      await db.seoAiVisibility.deleteMany({ where: { tenantId: null, domain: { in: subjects } } });
      await db.seoAiPrompt.deleteMany({
        where: {
          tenantId: null,
          OR: [
            { subject: { in: subjects } },
            { subjectType: 'tracked', prompt: { contains: 'ga4ia' } },
          ],
        },
      });
      await db.seoAiSource.deleteMany({ where: { tenantId: null, subject: { in: subjects } } });
      const admins = await db.superAdmin.findMany({
        where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } },
        select: { id: true },
      });
      await db.platformAiUsageEvent.deleteMany({
        where: { superAdminId: { in: admins.map((a) => a.id) } },
      });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  async function tenantSetup(u: VerifiedUser): Promise<string> {
    await setTenantFeatureOverride(u.slug, 'seo_advanced', true);
    const host = `web.${u.slug}.es`;
    await setVerifiedCustomDomain(u.slug, host);
    const res = await http()
      .post('/seo-advanced/project')
      .set({ Authorization: `Bearer ${u.accessToken}` })
      .send({});
    expect(res.status).toBe(201);
    await waitIdle(u.tenantId);
    return res.body.id as string;
  }

  /**
   * Una consulta de visibilidad en IA como la tanda real (mismas consultas y
   * mismo guardado), con las respuestas del servidor MCP simulado y sin pasar
   * por la conexión de SISTRIX de la plataforma.
   */
  async function fetchAi(id: string, fetchedAt: Date): Promise<string[]> {
    const sync = app.get(SistrixSyncService);
    const project = await withAdminDb((db) =>
      db.seoProject.findUniqueOrThrow({
        where: { id },
        include: { domains: true, competitors: true },
      }),
    );
    const items = await sync.buildItems(project, 'ai_visibility', 60);
    for (const item of items) {
      const call = toMcpCall(item.q);
      const outcome = normalizeSistrix(
        item.q.op,
        parseMcpResult(stubMcpResult(call.tool, call.args)),
      );
      if (outcome.kind !== 'ok') continue;
      await sync.store(project, poolOfProject(project), item, {
        kind: 'data',
        data: outcome.data,
        dataDate: null,
        provider: 'sistrix_mcp',
        fetchedAt,
        fromCache: false,
        credits: 0,
      });
    }
    return items.map((i) => `${i.q.op}:${i.q.domain ?? i.q.brands?.join(',') ?? i.q.prompt}`);
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super GA4', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte GA4', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    owner = await registerVerifiedUser(app, 'seoga4a');
    other = await registerVerifiedUser(app, 'seoga4b');
    tenantIds.push(owner.tenantId, other.tenantId);
    tenantProject = await tenantSetup(owner);
    otherProject = await tenantSetup(other);

    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'local', brandTerms: [BRAND] });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    await withAdminDb(async (db) => {
      const domain = await db.seoProjectDomain.create({
        data: { projectId, domain: HOST, role: 'primary', gscProperty: `sc-domain:${HOST}` },
      });
      await db.seoGscMetric.createMany({
        data: gscRows(null, domain.id, HOST) as Parameters<
          typeof db.seoGscMetric.createMany
        >[0]['data'],
      });
      await db.seoCompetitor.create({ data: { projectId, domain: COMP } });
      // Una conversión propia desde Google en «/precios» (PR 8).
      await db.seoConversionDaily.create({
        data: {
          projectId,
          date: asDate(shiftDate(LAST, -2)),
          type: 'booking_started',
          landingPath: '/precios',
          count: 2,
        },
      });
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('conecta GA4 en la plataforma, descarga 16 meses y repetir no duplica', async () => {
    const denied = await http()
      .put(`${admin()}/ga4`)
      .set(asSuper())
      .send({ source: 'own', propertyId: '403403403' });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('seo_ga4_no_access');
    expect(denied.body.message).toContain('Lector');

    const bad = await http()
      .put(`${admin()}/ga4`)
      .set(asSuper())
      .send({ source: 'own', propertyId: 'G-123' });
    expect(bad.status).toBe(400);

    // Soporte: solo lectura.
    const support = await http()
      .put(`${admin()}/ga4`)
      .set(asSupport())
      .send({ source: 'own', propertyId: PLATFORM_PROPERTY });
    expect(support.status).toBe(403);

    const res = await http()
      .put(`${admin()}/ga4`)
      .set(asSuper())
      .send({ source: 'own', propertyId: `properties/${PLATFORM_PROPERTY}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      propertyId: PLATFORM_PROPERTY,
      source: 'own',
      marketing: null,
    });
    expect(await waitGa4(projectId)).toBe('connected');

    const settings = await http().get(`${admin()}/ga4`).set(asSupport());
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ status: 'connected', initialDone: true });
    expect(settings.body.dataUntil).toBe(shiftDate(new Date().toISOString().slice(0, 10), -1));

    // Cada día: «/», «/precios» (junta la variante con parámetros) y la entrada sin página.
    const count = () => withAdminDb((db) => db.seoGa4LandingDaily.count({ where: { projectId } }));
    const before = await count();
    expect(before).toBe(486 * 3);
    const ga4 = app.get(SeoGa4Service);
    await ga4.sync(projectId);
    await ga4.sync(projectId);
    expect(await count()).toBe(before);
    const precios = await withAdminDb((db) =>
      db.seoGa4LandingDaily.findFirstOrThrow({
        where: { projectId, landingPath: '/precios' },
      }),
    );
    expect(precios).toMatchObject({ sessions: 14, engagedSessions: 4 });
  });

  it('cruza por página Search Console, GA4 y las conversiones propias', async () => {
    const res = await http().get(`${admin()}/ga4/pages?period=28d`).set(asSupport());
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(LAST);
    const precios = res.body.items.find((r: { landing: string }) => r.landing === '/precios');
    expect(precios.gsc).toMatchObject({ clicks: 84, impressions: 4200, position: 8 });
    expect(precios.ga4).toMatchObject({ sessions: 28 * 14, engagedSessions: 28 * 4 });
    expect(precios.conversions).toBe(2);
    // La página que solo tiene Search Console no se inventa sesiones.
    const solo = res.body.items.find((r: { landing: string }) => r.landing === '/solo-google');
    expect(solo.ga4).toBeNull();
    const home = res.body.items.find((r: { landing: string }) => r.landing === '/');
    expect(home.gsc).toBeNull();
    expect(res.body.totals.ga4.sessions).toBeGreaterThan(0);

    const byEngagement = await http()
      .get(`${admin()}/ga4/pages?period=28d&sort=engagement`)
      .set(asSuper());
    expect(byEngagement.body.items[0].landing).toBe('/precios');

    const page = await http()
      .get(`${admin()}/ga4/page?url=${encodeURIComponent(`https://${HOST}/precios/`)}&days=28`)
      .set(asSuper());
    expect(page.status).toBe(200);
    expect(page.body.landing).toBe('/precios');
    expect(page.body.metrics.sessions).toBe(28 * 14);
    expect(page.body.daily).toHaveLength(28);
  });

  it('el factor «Mucho tráfico y poca interacción» entra en la oportunidad de su búsqueda', async () => {
    await app.get(SeoOpportunityEngineService).recalculate(projectId);
    const opp = await withAdminDb((db) =>
      db.seoOpportunity.findFirstOrThrow({ where: { projectId, query: KEYWORD } }),
    );
    const factors = opp.factors as { key: string; detail: string }[];
    const engagement = factors.find((f) => f.key === 'engagement');
    expect(engagement?.detail).toContain('sesiones de Google en GA4');
  });

  it('el tenant reutiliza el GA4 de Marketing y no puede usar el de otro', async () => {
    const before = await http().get('/seo-advanced/ga4').set(asOwner());
    expect(before.status).toBe(200);
    expect(before.body.marketing).toEqual({ connected: false, propertyId: null });
    const missing = await http()
      .put('/seo-advanced/ga4')
      .set(asOwner())
      .send({ source: 'marketing' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('seo_ga4_marketing_missing');

    // Conectado en Marketing (Web Premium) y comprobado que es de su web.
    await withAdminDb((db) =>
      db.tenantGa4.create({
        data: {
          tenantId: owner.tenantId,
          propertyId: MARKETING_PROPERTY,
          status: 'connected',
          connectedAt: new Date(),
          verifiedAt: new Date(),
        },
      }),
    );
    const res = await http().put('/seo-advanced/ga4').set(asOwner()).send({ source: 'marketing' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'marketing',
      propertyId: MARKETING_PROPERTY,
      marketing: { connected: true, propertyId: MARKETING_PROPERTY },
    });
    expect(await waitGa4(tenantProject)).toBe('connected');

    // La propiedad de otro dueño (de Marketing o de la plataforma), no.
    const taken = await http()
      .put('/seo-advanced/ga4')
      .set(asOther())
      .send({ source: 'own', propertyId: MARKETING_PROPERTY });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('seo_ga4_property_taken');
    const platform = await http()
      .put('/seo-advanced/ga4')
      .set(asOther())
      .send({ source: 'own', propertyId: PLATFORM_PROPERTY });
    expect(platform.status).toBe(409);
    // Una propia exige comprobar que mide su web (su ID de medición).
    const own = await http()
      .put('/seo-advanced/ga4')
      .set(asOther())
      .send({ source: 'own', propertyId: OTHER_PROPERTY });
    expect(own.status).toBe(400);
    expect(own.body.code).toBe('ga4_measurement_id_required');

    // Cada tenant ve solo lo suyo.
    const mine = await http().get('/seo-advanced/ga4/pages?period=28d').set(asOwner());
    expect(mine.status).toBe(200);
    expect(mine.body.connected).toBe(true);
    expect(mine.body.totals.ga4.sessions).toBeGreaterThan(0);
    const theirs = await http().get('/seo-advanced/ga4/pages?period=28d').set(asOther());
    expect(theirs.body.connected).toBe(false);
    expect(theirs.body.totals.ga4).toBeNull();
    const otherRows = await withAdminDb((db) =>
      db.seoGa4LandingDaily.count({ where: { projectId: otherProject } }),
    );
    expect(otherRows).toBe(0);

    // Quitar la conexión de Marketing: la siguiente descarga lo dice.
    await withAdminDb((db) => db.tenantGa4.delete({ where: { tenantId: owner.tenantId } }));
    await app.get(SeoGa4Service).sync(tenantProject);
    const after = await http().get('/seo-advanced/ga4').set(asOwner());
    expect(after.body.status).toBe('error');
    expect(after.body.lastError).toContain('Marketing');
  });

  it('visibilidad en IA: marca, dominios y competidores, y los prompts que te faltan', async () => {
    const tracked = await http()
      .put(`${admin()}/ai-visibility/tracked-prompts`)
      .set(asSuper())
      .send({ prompts: ['Mejores trasteros ga4ia', 'mejores  trasteros ga4ia?'] });
    expect(tracked.status).toBe(200);
    expect(tracked.body.trackedPrompts).toEqual(['Mejores trasteros ga4ia']);
    const supportTracked = await http()
      .put(`${admin()}/ai-visibility/tracked-prompts`)
      .set(asSupport())
      .send({ prompts: [] });
    expect(supportTracked.status).toBe(403);

    const items = await fetchAi(projectId, new Date());
    // Resumen y prompts de tu dominio, tu marca y el competidor; fuentes, marcas y el seguido.
    expect(items).toEqual(
      expect.arrayContaining([
        `ai_overview:${HOST}`,
        `ai_overview:${BRAND}`,
        `ai_overview:${COMP}`,
        `ai_prompts:${HOST}`,
        `ai_prompts:${COMP}`,
        `ai_sources:${HOST}`,
        `ai_competitors:${HOST}`,
        'ai_answers:Mejores trasteros ga4ia',
      ]),
    );

    const res = await http().get(`${admin()}/ai-visibility/report`).set(asSupport());
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.country).toBe('es');
    expect(r.subjects.map((s: { subject: string; own: boolean }) => [s.subject, s.own])).toEqual([
      [HOST, true],
      [BRAND, true],
      [COMP, false],
    ]);
    expect(r.subjects[0].promptCount).toBe(312);
    expect(r.subjects[0].models.length).toBeGreaterThan(0);
    // El competidor sale en seis prompts y tú en tres: tres oportunidades.
    expect(r.ownPrompts.length).toBe(3);
    expect(r.gaps).toHaveLength(3);
    expect(r.gaps[0].competitors).toEqual([COMP]);
    // Tu web citada por las IA y las marcas que compiten.
    expect(r.citedPages.map((s: { source: string }) => s.source)).toEqual([
      `https://${HOST}/precios`,
    ]);
    expect(r.competitorBrands.length).toBe(2);
    // Las respuestas (HTML en SISTRIX) llegan como texto plano limpio, sin etiquetas.
    expect(r.tracked[0].answers.length).toBe(2);
    const answers = r.tracked[0].answers.map((a: { answer: string }) => a.answer).join(' ');
    expect(answers).toContain('compara precios y tamaños. texto https://ejemplo-ia.es/trasteros');
    expect(answers).not.toMatch(/<[a-z/]/i);
    expect(r.ownPrompts[0].answer).toMatch(/^- Respuesta de demostración/);
    expect(r.ownPrompts[0].answer).not.toContain('<');
    // Marcas que compiten: sin dominio ni recuento.
    expect(r.competitorBrands.map((b: { source: string }) => b.source)).toEqual([
      'Bluespace',
      'Lock & Go',
    ]);

    // «Preparar contenido» con el prompt como búsqueda (PR 11).
    const brief = await http()
      .post(`${admin()}/briefs`)
      .set(asSuper())
      .send({ source: 'prompt', prompt: r.gaps[0].prompt });
    expect(brief.status).toBe(201);
    expect(brief.body).toMatchObject({ source: 'prompt', sourceLabel: r.gaps[0].prompt });

    // El tenant con su propio fondo: no ve nada de lo de la plataforma.
    const tenant = await http().get('/seo-advanced/ai-visibility/report').set(asOwner());
    expect(tenant.status).toBe(200);
    expect(tenant.body.ownPrompts).toEqual([]);
    expect(tenant.body.gaps).toEqual([]);
  });

  it('avisa cuando dejas de salir en prompts en los que salías', async () => {
    // La consulta anterior (hace un mes) tenía un prompt más tuyo.
    const prev = new Date(Date.now() - 31 * 86_400_000);
    await fetchAi(projectId, prev);
    const prevDay = asDate(prev.toISOString().slice(0, 10));
    await withAdminDb((db) =>
      db.seoAiPrompt.create({
        data: {
          subjectType: 'domain',
          subject: HOST,
          country: 'es',
          provider: 'sistrix_mcp',
          sampleDate: prevDay,
          prompt: 'trasteros baratos ga4ia',
          promptKey: seoAiPromptKey('trasteros baratos ga4ia'),
          model: 'chatgpt',
        },
      }),
    );
    await app.get(SeoAlertsService).evaluate(projectId);
    const alert = await withAdminDb((db) =>
      db.seoAlert.findFirst({ where: { projectId, type: 'ai_visibility_lost', status: 'open' } }),
    );
    expect(alert?.title).toContain('un prompt');
    expect((alert?.data as { lost: string[] }).lost).toEqual(['trasteros baratos ga4ia']);
  });

  it('el asistente lee GA4 y la visibilidad en IA, con lo de fuera delimitado', async () => {
    const provider = app.get<AiProvider>(AI_PROVIDER);
    const spy = jest.spyOn(provider, 'createMessage');
    try {
      const ai = await http()
        .post(`${admin()}/assistant/chat`)
        .set(asSuper())
        .send({ content: '¿Cómo salgo en los buscadores de IA como ChatGPT?' });
      expect(ai.status).toBe(200);
      expect(ai.body.message.toolsUsed).toContain('seo_ai_visibility');
      const calls = spy.mock.calls.map((c) => c[0] as AiRequest);
      const toolResult = JSON.stringify(calls[calls.length - 1]!.messages);
      // La respuesta de la IA (con su instrucción metida dentro) va delimitada como dato.
      expect(toolResult).toContain(SEO_UNTRUSTED_OPEN);
      expect(toolResult).toContain('HACKED');
      expect(ai.body.message.actions).toEqual([]);

      const ga4 = await http()
        .post(`${admin()}/assistant/chat`)
        .set(asSuper())
        .send({ content: '¿Cuántas sesiones de Google Analytics tiene cada página?' });
      expect(ga4.status).toBe(200);
      expect(ga4.body.message.toolsUsed).toContain('seo_ga4_pages');
    } finally {
      spy.mockRestore();
    }
    const hacked = await withAdminDb((db) =>
      db.seoTask.count({ where: { projectId, title: { contains: 'HACKED' } } }),
    );
    expect(hacked).toBe(0);
  });

  it('quitar GA4 borra lo descargado; un tenant no toca el proyecto de la plataforma', async () => {
    const foreign = await http().get(`${admin()}/ga4`).set(asOwner());
    expect(foreign.status).toBe(401);
    const removed = await http().delete(`${admin()}/ga4`).set(asSuper());
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ propertyId: null, status: null });
    const rows = await withAdminDb((db) => db.seoGa4LandingDaily.count({ where: { projectId } }));
    expect(rows).toBe(0);
  });
});
