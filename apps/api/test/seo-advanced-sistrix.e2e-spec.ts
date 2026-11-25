import { hash as argonHash } from '@node-rs/argon2';
import request from 'supertest';

import { PrismaService } from '../src/modules/database/prisma.service';
import {
  SISTRIX_MCP_GATEWAY,
  type StubSistrixMcpGateway,
} from '../src/modules/seo-advanced/sistrix/sistrix-mcp.gateway';
import { sistrixQueryHash } from '../src/modules/seo-advanced/sistrix/sistrix-normalizer';
import { SistrixSyncService } from '../src/modules/seo-advanced/sistrix/sistrix-sync.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-sistrix-super@storageos.local';
const SUPPORT_EMAIL = 'seo-sistrix-support@storageos.local';
const PREFIX = 'E2E SISTRIX ';
/** Claves y tokens que nunca deben salir en una respuesta ni en el registro. */
const PLATFORM_KEY = 'platformkey123456';
const TENANT_KEY = 'tenantkey12345';

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/** Lo de la plataforma de estas pruebas: conexiones, ajustes y lo descargado. */
async function cleanupPlatform(): Promise<void> {
  await withAdminDb(async (db) => {
    await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
    await db.seoProviderConnection.deleteMany({ where: { tenantId: null } });
    await db.seoSyncSettings.deleteMany({ where: { tenantId: null } });
    await db.seoApiCache.deleteMany({ where: { tenantId: null } });
    await db.seoApiRequest.deleteMany({ where: { tenantId: null } });
    for (const t of [
      db.seoDomainMetric,
      db.seoDomainKeyword,
      db.seoDomainOpportunity,
      db.seoBacklinkTarget,
      db.seoAiVisibility,
      db.seoKeywordMetric,
      db.seoSerpResult,
    ] as unknown as { deleteMany: (a: object) => Promise<unknown> }[]) {
      await t.deleteMany({ where: { tenantId: null } });
    }
    await db.superAdminNotification.deleteMany({ where: { type: { startsWith: 'seo.sistrix' } } });
  });
}

/** Espera a que la tanda deje de estar en cola o en curso (la procesa el propio API). */
async function waitRun(
  runId: string,
): Promise<{ status: string; pausedReason: string | null; provider: string; creditsUsed: number }> {
  for (let i = 0; i < 160; i++) {
    const run = await withAdminDb((db) => db.seoSyncRun.findUnique({ where: { id: runId } }));
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`la tanda ${runId} no terminó`);
}

describe('SEO Avanzado: SISTRIX por MCP y por API (e2e, simulado)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  let stub: StubSistrixMcpGateway;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let projectA = '';
  let projectB = '';

  const createPlatformProject = async (name: string, domain: string): Promise<string> => {
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}${name}`, strategy: 'national' });
    expect(created.status).toBe(201);
    await withAdminDb((db) =>
      db.seoProjectDomain.create({
        data: {
          projectId: created.body.id,
          domain,
          role: 'primary',
          gscProperty: `sc-domain:${domain}`,
        },
      }),
    );
    return created.body.id as string;
  };

  const sync = async (projectId: string, dataType: string) => {
    const res = await http()
      .post(`/admin/seo/projects/${projectId}/sistrix/sync`)
      .set(asSuper())
      .send({ dataType });
    expect(res.status).toBe(201);
    return waitRun(res.body.id);
  };

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super SISTRIX', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte SISTRIX', role: 'support' },
      });
    });
    app = await createTestApp();
    stub = app.get(SISTRIX_MCP_GATEWAY);
    stub.reset();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await withAdminDb((db) =>
      db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } }),
    );
    await cleanupTestTenants();
  });

  it('conecta por OAuth: state firmado de un solo uso, tokens cifrados que nunca salen y catálogo de herramientas', async () => {
    expect((await http().post('/admin/seo/sistrix/connect').set(asSupport())).status).toBe(403);
    const started = await http().post('/admin/seo/sistrix/connect').set(asSuper());
    expect(started.status).toBe(201);
    const url = new URL(started.body.authorizationUrl);
    const state = url.searchParams.get('state')!;
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/v1\/admin\/seo\/sistrix\/callback$/);
    expect(state).toBeTruthy();

    // Un state manipulado no vale.
    const forged = await http()
      .get('/admin/seo/sistrix/callback')
      .query({ code: 'x', state: `${state}x` });
    expect(forged.status).toBe(302);
    expect(forged.headers.location).toContain('sistrix=error');

    const ok = await http().get('/admin/seo/sistrix/callback').query({ code: 'good-code', state });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/\/admin\/seo\/integrations\?sistrix=ok$/);
    // De un solo uso.
    const replay = await http()
      .get('/admin/seo/sistrix/callback')
      .query({ code: 'good-code', state });
    expect(replay.headers.location).toContain('sistrix=error');

    const conn = await withAdminDb((db) =>
      db.seoProviderConnection.findFirstOrThrow({
        where: { tenantId: null, provider: 'sistrix_mcp' },
      }),
    );
    expect(conn.status).toBe('connected');
    expect(conn.accessTokenEncrypted).toBeTruthy();
    expect(conn.accessTokenEncrypted).not.toContain('stub-access');
    expect(conn.refreshTokenEncrypted).not.toContain('stub-refresh');
    expect(conn.clientInfoEncrypted).not.toContain('stub-client-secret');
    expect(conn.toolsHash).toBeTruthy();

    const integ = await http().get('/admin/seo/sistrix').set(asSupport());
    expect(integ.status).toBe(200);
    expect(integ.body.mcp.status).toBe('connected');
    expect(integ.body.mcp.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['domain', 'keyword', 'keyword_domain_seo', 'links', 'ai_check']),
    );
    const text = JSON.stringify(integ.body);
    expect(text).not.toMatch(/stub-access|stub-refresh|stub-client-secret|stub-verifier/);

    const test = await http().post('/admin/seo/sistrix/test').set(asSuper());
    expect(test.body).toMatchObject({ ok: true, provider: 'sistrix_mcp' });
  });

  it('detecta el cambio de herramientas y avisa si desaparece algo que usamos', async () => {
    stub.toolsVariant = 'changed';
    const res = await http().post('/admin/seo/sistrix/tools/refresh').set(asSuper());
    expect(res.status).toBe(201);
    expect(res.body.mcp.toolsChanges).toMatchObject({
      affectsUs: true,
      addedTools: ['domain_history'],
      removedViews: [{ tool: 'domain', view: 'opportunities' }],
    });
    const n = await withAdminDb((db) =>
      db.superAdminNotification.count({ where: { type: 'seo.sistrix_tools_changed' } }),
    );
    expect(n).toBeGreaterThanOrEqual(1);
    stub.toolsVariant = 'default';
    await http().post('/admin/seo/sistrix/tools/refresh').set(asSuper());
  });

  it('sincroniza visibilidad, competidores, palabras, resultados y métricas guardando proveedor y fecha', async () => {
    projectA = await createPlatformProject('A', 'e2e-sistrix-a.es');
    // El soporte solo lee.
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${projectA}/competitors`)
          .set(asSupport())
          .send({ domain: 'bluespace.es' })
      ).status,
    ).toBe(403);
    const comp = await http()
      .post(`/admin/seo/projects/${projectA}/competitors`)
      .set(asSuper())
      .send({ domain: 'https://www.BlueSpace.es/precios', name: 'Bluespace' });
    expect(comp.status).toBe(201);
    expect(comp.body[0]).toMatchObject({
      domain: 'bluespace.es',
      isActive: true,
      source: 'manual',
    });
    const own = await http()
      .post(`/admin/seo/projects/${projectA}/competitors`)
      .set(asSuper())
      .send({ domain: 'e2e-sistrix-a.es' });
    expect(own.body.code).toBe('seo_competitor_own');

    const kws = await http()
      .post(`/admin/seo/projects/${projectA}/keywords`)
      .set(asSuper())
      .send({ keywords: ['Trasteros  Valencia', 'guardamuebles valencia'], priority: 1 });
    expect(kws.status).toBe(201);
    expect(kws.body.map((k: { keyword: string }) => k.keyword).sort()).toEqual([
      'guardamuebles valencia',
      'trasteros valencia',
    ]);

    expect((await sync(projectA, 'visibility')).status).toBe('done');
    const vis = await http().get(`/admin/seo/projects/${projectA}/visibility`).set(asSuper());
    const blue = vis.body.find((s: { domain: string }) => s.domain === 'bluespace.es');
    expect(blue.own).toBe(false);
    expect(blue.points.length).toBeGreaterThan(1);
    expect(blue.latest).toMatchObject({ provider: 'sistrix_mcp' });
    expect(blue.latest.fetchedAt).toBeTruthy();
    expect(blue.latest.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await sync(projectA, 'competitors')).status).toBe('done');
    const comps = await http().get(`/admin/seo/projects/${projectA}/competitors`).set(asSuper());
    const discovered = comps.body.filter((c: { source: string }) => c.source === 'discovered');
    expect(discovered.length).toBeGreaterThan(0);
    // Los descubiertos entran como sugerencia (sin seguir).
    expect(discovered.every((c: { isActive: boolean }) => !c.isActive)).toBe(true);
    const dk = await http()
      .get(`/admin/seo/projects/${projectA}/domain-keywords`)
      .query({ domain: 'bluespace.es' })
      .set(asSuper());
    expect(dk.body.items.length).toBeGreaterThan(0);
    expect(dk.body.origin.provider).toBe('sistrix_mcp');
    // Solo dominios del proyecto o de sus competidores.
    const foreign = await http()
      .get(`/admin/seo/projects/${projectA}/domain-keywords`)
      .query({ domain: 'cualquiera.es' })
      .set(asSuper());
    expect(foreign.status).toBe(400);

    expect((await sync(projectA, 'serp')).status).toBe('done');
    expect((await sync(projectA, 'keyword_metrics')).status).toBe('done');
    const list = await http().get(`/admin/seo/projects/${projectA}/keywords`).set(asSuper());
    const tv = list.body.find((k: { keyword: string }) => k.keyword === 'trasteros valencia');
    expect(tv.metrics).toMatchObject({ provider: 'sistrix_mcp' });
    expect(typeof tv.metrics.traffic).toBe('number');
    expect(tv.metrics.intent.visit).toBe(80);
    expect(tv.serp).toMatchObject({ provider: 'sistrix_mcp', competitors: 1 });
    const serp = await http()
      .get(`/admin/seo/projects/${projectA}/keywords/${tv.id}/serp`)
      .set(asSuper());
    expect(serp.body.results).toHaveLength(10);
    expect(
      serp.body.results.find((r: { domain: string }) => r.domain === 'bluespace.es').competitor,
    ).toBe(true);

    for (const t of ['opportunities', 'backlinks', 'ai_visibility']) {
      expect((await sync(projectA, t)).status).toBe('done');
    }
    const opp = await http().get(`/admin/seo/projects/${projectA}/opportunities`).set(asSuper());
    expect(opp.body.items.length).toBeGreaterThan(0);
    const links = await http().get(`/admin/seo/projects/${projectA}/backlinks`).set(asSuper());
    // Ordenadas por dominios que enlazan.
    expect(links.body.items[0]).toMatchObject({ links: 230, domains: 133 });
    expect(links.body.origin.provider).toBe('sistrix_mcp');
    const ai = await http().get(`/admin/seo/projects/${projectA}/ai-visibility`).set(asSuper());
    expect(ai.body.find((r: { domain: string }) => r.domain === 'bluespace.es')).toMatchObject({
      promptCount: 312,
      provider: 'sistrix_mcp',
    });

    const ws = await http().get(`/admin/seo/projects/${projectA}/sistrix`).set(asSupport());
    expect(ws.body).toMatchObject({
      pool: 'platform',
      available: true,
      routing: { provider: 'sistrix_mcp' },
    });
    expect(ws.body.lastSync.visibility.status).toBe('done');
  });

  it('dos proyectos que piden la misma palabra hacen una sola consulta (caché compartida)', async () => {
    projectB = await createPlatformProject('B', 'e2e-sistrix-b.es');
    await http()
      .post(`/admin/seo/projects/${projectB}/keywords`)
      .set(asSuper())
      .send({ keywords: ['trasteros valencia'] });
    expect((await sync(projectB, 'keyword_metrics')).status).toBe('done');
    const hash = sistrixQueryHash({ op: 'metrics', keyword: 'trasteros valencia', country: 'es' });
    const [real, cached] = await withAdminDb((db) =>
      Promise.all([
        db.seoApiRequest.count({ where: { queryHash: hash, status: { not: 'cached' } } }),
        db.seoApiRequest.count({ where: { queryHash: hash, status: 'cached' } }),
      ]),
    );
    expect(real).toBe(1);
    expect(cached).toBeGreaterThanOrEqual(1);
    const list = await http().get(`/admin/seo/projects/${projectB}/keywords`).set(asSuper());
    expect(list.body[0].metrics).toMatchObject({ provider: 'sistrix_mcp' });
  });

  it('con el 7010 se para; «Continuar por API» solo con autorización, API activa y presupuesto', async () => {
    stub.forceQuota = true;
    await http()
      .post(`/admin/seo/projects/${projectA}/keywords`)
      .set(asSuper())
      .send({ keywords: ['trasteros mislata'] });
    const res = await http()
      .post(`/admin/seo/projects/${projectA}/sistrix/sync`)
      .set(asSuper())
      .send({ dataType: 'serp' });
    let run = await waitRun(res.body.id);
    expect(run).toMatchObject({ status: 'waiting', pausedReason: 'mcp_quota' });
    const conn = await withAdminDb((db) =>
      db.seoProviderConnection.findFirstOrThrow({
        where: { tenantId: null, provider: 'sistrix_mcp' },
      }),
    );
    expect(conn.quotaExhaustedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(
      await withAdminDb((db) =>
        db.superAdminNotification.count({ where: { type: 'seo.sistrix_quota' } }),
      ),
    ).toBe(1);

    // Sin API activa no hay nada que autorizar.
    let integ = await http().get('/admin/seo/sistrix').set(asSuper());
    expect(integ.body.canContinueByApi).toBe(false);
    expect(integ.body.mcp.quotaExhaustedUntil).toBeTruthy();
    expect((await http().post('/admin/seo/sistrix/api/authorize').set(asSuper())).body.code).toBe(
      'sistrix_api_not_ready',
    );
    const api = await http()
      .put('/admin/seo/sistrix/api')
      .set(asSuper())
      .send({ apiKey: PLATFORM_KEY, enabled: true, weeklyBudget: 0 });
    expect(api.status).toBe(200);
    expect(api.body).toMatchObject({ enabled: true, hasKey: true, keyLast4: '3456' });
    expect(JSON.stringify(api.body)).not.toContain(PLATFORM_KEY);
    // Sin presupuesto tampoco.
    expect((await http().post('/admin/seo/sistrix/api/authorize').set(asSuper())).body.code).toBe(
      'sistrix_api_budget',
    );
    // Activada pero sin autorizar: la tanda sigue esperando y no gasta.
    run = await waitRun(res.body.id);
    expect(run.status).toBe('waiting');

    await http().put('/admin/seo/sistrix/api').set(asSuper()).send({ weeklyBudget: 500 });
    // Al guardar se despierta la tanda, que vuelve a esperar (sigue sin autorización).
    expect((await waitRun(res.body.id)).status).toBe('waiting');
    integ = await http().get('/admin/seo/sistrix').set(asSuper());
    expect(integ.body.canContinueByApi).toBe(true);
    expect((await http().post('/admin/seo/sistrix/api/authorize').set(asSupport())).status).toBe(
      403,
    );
    const auth = await http().post('/admin/seo/sistrix/api/authorize').set(asSuper());
    expect(auth.status).toBe(201);
    // Caduca cuando se reanuda el MCP.
    expect(auth.body.api.authorizedUntil).toBe(integ.body.mcp.quotaExhaustedUntil);
    run = await waitRun(res.body.id);
    expect(run).toMatchObject({ status: 'done', provider: 'sistrix_api' });
    expect(run.creditsUsed).toBeGreaterThan(0);
    const apiConn = await withAdminDb((db) =>
      db.seoProviderConnection.findFirstOrThrow({
        where: { tenantId: null, provider: 'sistrix_api' },
      }),
    );
    expect(apiConn.weekSpent).toBe(run.creditsUsed);
    expect(apiConn.creditsBalance).toBe(10_000);

    // El registro de peticiones no lleva la clave ni tokens.
    const reqs = await http()
      .get('/admin/seo/sistrix/requests')
      .query({ provider: 'sistrix_api' })
      .set(asSupport());
    expect(reqs.body.items.length).toBeGreaterThan(0);
    expect(reqs.body.items[0].tool).toBe('keyword.seo');
    const all = JSON.stringify(
      (await http().get('/admin/seo/sistrix/requests').set(asSuper())).body,
    );
    expect(all).not.toContain(PLATFORM_KEY);
    expect(all).not.toMatch(/api_key|stub-access/);
    const rows = await withAdminDb((db) =>
      db.seoApiRequest.findMany({ where: { tenantId: null } }),
    );
    expect(JSON.stringify(rows)).not.toContain(PLATFORM_KEY);

    // A las 00:05 vuelve la cuota: se quita la pausa y caduca la autorización.
    stub.forceQuota = false;
    await withAdminDb((db) =>
      db.seoProviderConnection.updateMany({
        where: { tenantId: null, provider: 'sistrix_mcp' },
        data: { quotaExhaustedUntil: new Date(Date.now() - 60_000) },
      }),
    );
    await app.get(SistrixSyncService).resumeWaiting();
    integ = await http().get('/admin/seo/sistrix').set(asSuper());
    expect(integ.body.mcp.quotaExhaustedUntil).toBeNull();
    expect(integ.body.api.authorizedUntil).toBeNull();
    expect(integ.body.routing.provider).toBe('sistrix_mcp');
    await http().put('/admin/seo/sistrix/api').set(asSuper()).send({ enabled: false });
  });

  it('tenant: sin clave solo Search Console; con su clave, SISTRIX por API y aislado de los demás', async () => {
    const owner = await registerVerifiedUser(app, 'seosistrixa');
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    expect(project.status).toBe(201);

    const empty = await http().get('/seo-advanced/sistrix').set(a);
    expect(empty.status).toBe(200);
    expect(empty.body.workspace).toMatchObject({ pool: 'tenant', available: false });
    expect(empty.body.workspace.unavailableReason).toMatch(/clave de API/);
    expect(empty.body.settings.api.hasKey).toBe(false);
    const blocked = await http()
      .post('/seo-advanced/sistrix/sync')
      .set(a)
      .send({ dataType: 'visibility' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('sistrix_not_configured');

    // Competidores y palabras se gestionan igual (con su límite).
    const comp = await http()
      .post('/seo-advanced/competitors')
      .set(a)
      .send({ domain: 'trasterosalmirante.es' });
    expect(comp.status).toBe(201);

    const key = await http()
      .put('/seo-advanced/sistrix/api')
      .set(a)
      .send({ apiKey: TENANT_KEY, enabled: true, weeklyBudget: 200 });
    expect(key.status).toBe(200);
    expect(key.body).toMatchObject({ hasKey: true, keyLast4: '2345', enabled: true });
    expect(JSON.stringify(key.body)).not.toContain(TENANT_KEY);
    const test = await http().post('/seo-advanced/sistrix/api/test').set(a);
    expect(test.body).toMatchObject({ ok: true, provider: 'sistrix_api', credits: 10_000 });

    const started = await http()
      .post('/seo-advanced/sistrix/sync')
      .set(a)
      .send({ dataType: 'visibility' });
    expect(started.status).toBe(201);
    const run = await waitRun(started.body.id);
    expect(run).toMatchObject({ status: 'done', provider: 'sistrix_api' });
    const vis = await http().get('/seo-advanced/visibility').set(a);
    const almirante = vis.body.find(
      (s: { domain: string }) => s.domain === 'trasterosalmirante.es',
    );
    expect(almirante.latest.provider).toBe('sistrix_api');
    const stored = await withAdminDb((db) =>
      db.seoDomainMetric.count({ where: { tenantId: owner.tenantId, provider: 'sistrix_api' } }),
    );
    expect(stored).toBeGreaterThan(0);

    // Otro tenant con el extra no ve nada de este.
    const other = await registerVerifiedUser(app, 'seosistrixb');
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(other.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(other.slug, `web.${other.slug}.es`);
    await http().post('/seo-advanced/project').set(b).send({});
    expect((await http().get('/seo-advanced/competitors').set(b)).body).toEqual([]);
    const otherVis = await http().get('/seo-advanced/visibility').set(b);
    expect(otherVis.body.every((s: { points: unknown[] }) => s.points.length === 0)).toBe(true);
    // Y la política de filas tampoco se lo deja ver.
    const leaked = await app
      .get(PrismaService)
      .withTenant(
        (tx) => tx.seoDomainMetric.count({ where: { tenantId: owner.tenantId } }),
        other.tenantId,
      );
    expect(leaked).toBe(0);
    // Ni la plataforma lo usa: sus datos van en el fondo del tenant.
    const platformLeak = await withAdminDb((db) =>
      db.seoDomainMetric.count({ where: { tenantId: null, provider: 'sistrix_api' } }),
    );
    expect(platformLeak).toBe(0);
  });

  it('un proyecto de tenant usa la conexión de la plataforma solo si lo activa el superadmin', async () => {
    const owner = await registerVerifiedUser(app, 'seosistrixc');
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    const id = project.body.id as string;

    expect(
      (
        await http()
          .patch(`/admin/seo/projects/${id}/sistrix-platform`)
          .set(asSupport())
          .send({ usePlatformSistrix: true })
      ).status,
    ).toBe(403);
    const on = await http()
      .patch(`/admin/seo/projects/${id}/sistrix-platform`)
      .set(asSuper())
      .send({ usePlatformSistrix: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ pool: 'platform', usePlatformSistrix: true });
    // En un proyecto de la plataforma no tiene sentido.
    expect(
      (
        await http()
          .patch(`/admin/seo/projects/${projectA}/sistrix-platform`)
          .set(asSuper())
          .send({ usePlatformSistrix: true })
      ).body.code,
    ).toBe('seo_platform_project');
    // Lo que sea de un tenant, en el panel admin solo se lee.
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${id}/competitors`)
          .set(asSuper())
          .send({ domain: 'x.es' })
      ).status,
    ).toBe(404);

    const ws = await http().get('/seo-advanced/sistrix').set(a);
    expect(ws.body.settings.usingPlatform).toBe(true);
    expect(ws.body.workspace).toMatchObject({ pool: 'platform', available: true });
    const started = await http()
      .post('/seo-advanced/sistrix/sync')
      .set(a)
      .send({ dataType: 'backlinks' });
    expect(started.status).toBe(201);
    const run = await waitRun(started.body.id);
    expect(run).toMatchObject({ status: 'done', provider: 'sistrix_mcp' });
    const links = await http().get('/seo-advanced/backlinks').set(a);
    expect(links.body.origin.provider).toBe('sistrix_mcp');
  });

  it('si la renovación da invalid_grant: hay que volver a conectar, se avisa y se para', async () => {
    await withAdminDb((db) =>
      db.seoProviderConnection.updateMany({
        where: { tenantId: null, provider: 'sistrix_mcp' },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      }),
    );
    stub.forceInvalidGrant = true;
    const res = await http()
      .post(`/admin/seo/projects/${projectA}/sistrix/sync`)
      .set(asSuper())
      .send({ dataType: 'keyword_ideas' });
    const run = await waitRun(res.body.id);
    expect(run).toMatchObject({ status: 'waiting', pausedReason: 'mcp_needs_reauth' });
    const integ = await http().get('/admin/seo/sistrix').set(asSuper());
    expect(integ.body.mcp.status).toBe('needs_reauth');
    expect(
      await withAdminDb((db) =>
        db.superAdminNotification.count({ where: { type: 'seo.sistrix_reauth' } }),
      ),
    ).toBe(1);

    expect((await http().delete('/admin/seo/sistrix/connection').set(asSupport())).status).toBe(
      403,
    );
    const off = await http().delete('/admin/seo/sistrix/connection').set(asSuper());
    expect(off.status).toBe(200);
    expect(off.body.mcp.status).toBe('disconnected');
    expect(stub.revoked.length).toBeGreaterThan(0);
    const conn = await withAdminDb((db) =>
      db.seoProviderConnection.findFirstOrThrow({
        where: { tenantId: null, provider: 'sistrix_mcp' },
      }),
    );
    expect(conn.accessTokenEncrypted).toBeNull();
    expect(conn.refreshTokenEncrypted).toBeNull();
  });
});
