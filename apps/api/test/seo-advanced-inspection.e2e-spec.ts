import { hash as argonHash } from '@node-rs/argon2';
import { seoNextQuotaReset, shiftDate } from '@storageos/shared';
import request from 'supertest';

import { SeoInspectionService } from '../src/modules/seo-advanced/technical/seo-inspection.service';
import { SeoPageSpeedService } from '../src/modules/seo-advanced/technical/seo-pagespeed.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-inspect-super@storageos.local';
const SUPPORT_EMAIL = 'seo-inspect-support@storageos.local';
const PREFIX = 'E2E inspección ';
const PLATFORM_DOMAIN = 'e2e-inspeccion-seo.es';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
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

describe('SEO Avanzado: inspección de URL y PageSpeed (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  const tenantIds: string[] = [];
  let owner: VerifiedUser;
  let other: VerifiedUser;
  let tenantProject = '';
  let tenantHost = '';
  let otherHost = '';
  let platformProject = '';
  let platformDomain = '';
  let inspection: SeoInspectionService;
  let pagespeed: SeoPageSpeedService;
  const a = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const b = () => ({ Authorization: `Bearer ${other.accessToken}` });

  /** Atiende la cola de inspecciones y de PageSpeed de un proyecto hasta vaciarla. */
  async function drain(projectId: string): Promise<void> {
    for (let i = 0; i < 120; i++) {
      await inspection.processQueue(projectId);
      await pagespeed.processQueue(projectId);
      const [x, y] = await withAdminDb((db) =>
        Promise.all([
          db.seoUrlInspection.count({
            where: {
              projectId,
              status: { in: ['queued', 'running'] },
              OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
            },
          }),
          db.seoPageSpeedRun.count({ where: { projectId, status: { in: ['queued', 'running'] } } }),
        ]),
      );
      if (x + y === 0) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('la cola no se vació');
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

  /** Crea el proyecto del tenant con su dominio principal. */
  async function tenantSetup(u: VerifiedUser): Promise<{ projectId: string; host: string }> {
    await setTenantFeatureOverride(u.slug, 'seo_advanced', true);
    const host = `web.${u.slug}.es`;
    await setVerifiedCustomDomain(u.slug, host);
    const res = await http()
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
        data: {
          email: SUPER_EMAIL,
          passwordHash,
          fullName: 'Super Inspección',
          role: 'superadmin',
        },
      });
      await db.superAdmin.create({
        data: {
          email: SUPPORT_EMAIL,
          passwordHash,
          fullName: 'Soporte Inspección',
          role: 'support',
        },
      });
    });
    app = await createTestApp();
    inspection = app.get(SeoInspectionService);
    pagespeed = app.get(SeoPageSpeedService);
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    owner = await registerVerifiedUser(app, 'seoinsa');
    other = await registerVerifiedUser(app, 'seoinsb');
    tenantIds.push(owner.tenantId, other.tenantId);
    const t = await tenantSetup(owner);
    tenantProject = t.projectId;
    tenantHost = t.host;
    otherHost = (await tenantSetup(other)).host;

    // Proyecto de la plataforma con páginas en Search Console (las de más clics).
    const created = await http()
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
            domain: PLATFORM_DOMAIN,
            role: 'primary',
            gscProperty: `sc-domain:${PLATFORM_DOMAIN}`,
            dataUntil: asDate(TODAY),
          },
        }),
      )
    ).id;
    const rows: object[] = [];
    for (let d = shiftDate(TODAY, -10); d <= TODAY; d = shiftDate(d, 1)) {
      for (const [path, clicks] of [
        ['/', 50],
        ['/blog', 30],
        ['/precios', 20],
        ['/contacto', 10],
      ] as const) {
        rows.push({
          tenantId: null,
          domainId: platformDomain,
          grain: 'page',
          date: asDate(d),
          query: '',
          page: `https://${PLATFORM_DOMAIN}${path}`,
          device: '',
          country: '',
          clicks,
          impressions: clicks * 10,
          ctr: 0.1,
          position: 5,
        });
      }
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('inspecciona bajo demanda, cuenta la cuota y guarda el histórico', async () => {
    const res = await http().post('/seo-advanced/inspections').set(a()).send({ url: '/precios' });
    expect(res.status).toBe(200);
    expect(res.body.deferred).toBe(false);
    expect(res.body.inspection).toMatchObject({
      url: `https://${tenantHost}/precios`,
      status: 'done',
      verdict: 'PASS',
      indexed: true,
      canonicalMismatch: false,
      reason: 'manual',
      trigger: 'manual',
    });
    // Una URL que no es del proyecto (la de otro negocio) no se inspecciona.
    const foreign = await http()
      .post('/seo-advanced/inspections')
      .set(a())
      .send({ url: `https://${otherHost}/precios` });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('url_not_in_project');

    const again = await http()
      .post('/seo-advanced/inspections')
      .set(a())
      .send({ url: '/Precios/' });
    expect(again.status).toBe(200);
    const list = await http().get('/seo-advanced/inspections').set(a());
    expect(list.status).toBe(200);
    expect(list.body.quota).toMatchObject({ used: 2, cap: 200, remaining: 198, googleLimit: 2000 });
    expect(list.body.summary).toMatchObject({ urls: 1, indexed: 1, notIndexed: 0 });
    const hist = await http()
      .get('/seo-advanced/inspections/history')
      .query({ url: '/precios' })
      .set(a());
    expect(hist.status).toBe(200);
    expect(hist.body.items).toHaveLength(2);

    // Aislamiento: el otro negocio no ve nada de esto.
    const theirs = await http().get('/seo-advanced/inspections').set(b());
    expect(theirs.status).toBe(200);
    expect(theirs.body.items).toEqual([]);
    expect(theirs.body.quota.used).toBe(0);
  });

  it('integra la inspección en Indexación, palabras seguidas y alertas (sin duplicar)', async () => {
    // Una palabra importante cuya URL objetivo Google no tiene.
    const add = await http()
      .post('/seo-advanced/keywords')
      .set(a())
      .send({ keywords: ['trasteros noindex'], priority: 1 });
    expect(add.status).toBe(201);
    await withAdminDb((db) =>
      db.seoProjectKeyword.updateMany({
        where: { projectId: tenantProject },
        data: { targetUrl: '/objetivo-noindex', isActive: true, priority: 1 },
      }),
    );
    const notIndexed = await http()
      .post('/seo-advanced/inspections')
      .set(a())
      .send({ url: '/objetivo-noindex' });
    expect(notIndexed.body.inspection).toMatchObject({
      indexed: false,
      indexingState: 'BLOCKED_BY_META_TAG',
    });
    expect(notIndexed.body.inspection.notIndexedReason).toContain('noindex');
    const canonical = await http()
      .post('/seo-advanced/inspections')
      .set(a())
      .send({ url: '/pagina-canonical' });
    expect(canonical.body.inspection.canonicalMismatch).toBe(true);

    const findings = async () =>
      (await http().get('/seo-advanced/diagnostics/index-findings').set(a())).body.items as {
        category: string;
        evidence: string;
        url: string;
        inspection: { indexed: boolean; label: string } | null;
      }[];
    let list = await findings();
    const nf = list.find((f) => f.category === 'not_indexed');
    expect(nf).toMatchObject({
      evidence: 'inspection',
      url: `https://${tenantHost}/objetivo-noindex`,
    });
    expect(nf!.inspection!.label).toContain('Google dice que no está indexada');
    expect(list.find((f) => f.category === 'canonical_mismatch')?.evidence).toBe('inspection');

    // El recálculo del diagnóstico no apaga lo que dice la inspección.
    expect((await http().post('/seo-advanced/diagnostics/recalculate').set(a())).status).toBe(201);
    list = await findings();
    expect(list.filter((f) => f.evidence === 'inspection')).toHaveLength(2);

    // La ficha de la palabra lleva lo que dice Google de su URL objetivo.
    const tracked = await http().get('/seo-advanced/diagnostics/tracked-keywords').set(a());
    const word = (
      tracked.body.items as { keyword: string; targetIndex: { indexed: boolean } | null }[]
    ).find((k) => k.keyword === 'trasteros noindex');
    expect(word?.targetIndex?.indexed).toBe(false);

    // Alertas: URL objetivo desindexada y canónica distinta, una sola vez.
    expect((await http().post('/seo-advanced/alerts/check').set(a())).status).toBe(200);
    expect((await http().post('/seo-advanced/alerts/check').set(a())).status).toBe(200);
    const alerts = await http().get('/seo-advanced/alerts').query({ status: 'live' }).set(a());
    const types = (alerts.body.items as { type: string; severity: string }[]).map((x) => x.type);
    expect(types.filter((t) => t === 'target_not_indexed')).toHaveLength(1);
    expect(types.filter((t) => t === 'canonical_mismatch')).toHaveLength(1);
    expect(
      (alerts.body.items as { type: string; severity: string }[]).find(
        (x) => x.type === 'target_not_indexed',
      )?.severity,
    ).toBe('high');

    // La URL objetivo pasa a estar bien: el hallazgo y la alerta se resuelven solos.
    await withAdminDb((db) =>
      db.seoProjectKeyword.updateMany({
        where: { projectId: tenantProject },
        data: { targetUrl: '/precios' },
      }),
    );
    await http().post('/seo-advanced/inspections').set(a()).send({ url: '/objetivo-noindex' });
    list = await findings();
    expect(list.find((f) => f.category === 'not_indexed')).toBeUndefined();
    await http().post('/seo-advanced/alerts/check').set(a());
    const after = await http().get('/seo-advanced/alerts').query({ status: 'live' }).set(a());
    expect(
      (after.body.items as { type: string }[]).some((x) => x.type === 'target_not_indexed'),
    ).toBe(false);
  });

  it('cuota: un 429 no cuenta y al llegar al tope la petición espera al día siguiente con aviso', async () => {
    const before = (await http().get('/seo-advanced/inspections').set(a())).body.quota
      .used as number;
    const limited = await http()
      .post('/seo-advanced/inspections')
      .set(a())
      .send({ url: '/ratelimit' });
    expect(limited.status).toBe(200);
    expect(limited.body.deferred).toBe(true);
    expect(limited.body.inspection.status).toBe('queued');
    let quota = (await http().get('/seo-advanced/inspections').set(a())).body.quota;
    expect(quota.used).toBe(before);
    expect(quota.waitingNextDay).toBe(1);

    // Tope del proyecto = lo gastado: la siguiente espera a que se reinicie la cuota.
    const set = await http()
      .put('/seo-advanced/technical/settings')
      .set(a())
      .send({ inspectionDailyCap: before });
    expect(set.status).toBe(200);
    expect(set.body.inspectionDailyCap).toBe(before);
    const capped = await http().post('/seo-advanced/inspections').set(a()).send({ url: '/blog' });
    expect(capped.body.deferred).toBe(true);
    expect(capped.body.message).toContain('No queda cuota');
    expect(Date.parse(capped.body.inspection.scheduledFor)).toBe(
      seoNextQuotaReset(new Date()).getTime(),
    );
    quota = (await http().get('/seo-advanced/inspections').set(a())).body.quota;
    expect(quota).toMatchObject({ used: before, remaining: 0, waitingNextDay: 2 });
    // Atender la cola no las hace hoy.
    await inspection.processQueue(tenantProject);
    expect(
      await withAdminDb((db) =>
        db.seoUrlInspection.count({ where: { projectId: tenantProject, status: 'queued' } }),
      ),
    ).toBe(2);
    // Un aviso al equipo, una sola vez.
    const notices = await withAdminDb((db) =>
      db.notification.count({ where: { tenantId: owner.tenantId, type: 'seo.inspection_quota' } }),
    );
    expect(notices).toBeGreaterThanOrEqual(1);
    const notices2 = await withAdminDb((db) =>
      db.notification.count({ where: { tenantId: owner.tenantId, type: 'seo.inspection_quota' } }),
    );
    expect(notices2).toBe(notices);
    // Solo quien configura inspecciona: el soporte del panel admin lee y no cambia.
    expect(
      (await http().get(`/admin/seo/projects/${tenantProject}/inspections`).set(asSupport()))
        .status,
    ).toBe(200);
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${tenantProject}/inspections`)
          .set(asSupport())
          .send({ url: '/precios' })
      ).status,
    ).toBe(403);
    // El super admin no inspecciona los proyectos de los tenants.
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${tenantProject}/inspections`)
          .set(asSuper())
          .send({ url: '/precios' })
      ).status,
    ).toBe(404);
  });

  it('lote programado acotado y sin repetir antes de N días', async () => {
    const base = `/admin/seo/projects/${platformProject}`;
    const s = await http()
      .put(`${base}/technical/settings`)
      .set(asSuper())
      .send({ inspectionBatchEnabled: true, inspectionBatchMax: 3, inspectionReinspectDays: 14 });
    expect(s.status).toBe(200);
    // Una palabra importante con URL objetivo (va primero) y las páginas de más clics.
    const add = await http()
      .post(`${base}/keywords`)
      .set(asSuper())
      .send({ keywords: ['trasteros e2e inspeccion'], priority: 1 });
    expect(add.status).toBe(201);
    await withAdminDb((db) =>
      db.seoProjectKeyword.updateMany({
        where: { projectId: platformProject },
        data: { targetUrl: '/objetivo', priority: 1, isActive: true },
      }),
    );
    const first = await http().post(`${base}/inspections/batch`).set(asSuper());
    expect(first.status).toBe(200);
    expect(first.body.queued).toBe(3);
    await drain(platformProject);
    const done = await withAdminDb((db) =>
      db.seoUrlInspection.findMany({
        where: { projectId: platformProject, status: 'done' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(done.every((d) => d.trigger === 'batch')).toBe(true);
    expect(done.map((d) => d.reason).sort()).toEqual(['target_high', 'top_clicks', 'top_clicks']);
    expect(done.map((d) => d.url).sort()).toEqual([
      `https://${PLATFORM_DOMAIN}/`,
      `https://${PLATFORM_DOMAIN}/blog`,
      `https://${PLATFORM_DOMAIN}/objetivo`,
    ]);
    // Lo inspeccionado no vuelve: el siguiente lote solo trae las que faltan.
    const second = await http().post(`${base}/inspections/batch`).set(asSuper());
    expect(second.body.queued).toBe(2);
    await drain(platformProject);
    const third = await http().post(`${base}/inspections/batch`).set(asSuper());
    expect(third.body.queued).toBe(0);
    // El cron diario solo arma el lote de quien lo activa (este ya no tiene nada que hacer).
    expect((await inspection.enqueueBatchesAll()).queued).toBe(0);
    // Soporte: solo lectura.
    expect((await http().post(`${base}/inspections/batch`).set(asSupport())).status).toBe(403);
    const list = await http().get(`${base}/inspections`).set(asSupport());
    expect(list.status).toBe(200);
    expect(list.body.summary.urls).toBe(5);
  });

  it('PageSpeed bajo demanda y semanal, con histórico y alertas', async () => {
    const run = await http().post('/seo-advanced/pagespeed').set(a()).send({ url: '/' });
    expect(run.status).toBe(200);
    expect((run.body as { strategy: string }[]).map((r) => r.strategy).sort()).toEqual([
      'desktop',
      'mobile',
    ]);
    // La URL de otro negocio no se mide.
    expect(
      (
        await http()
          .post('/seo-advanced/pagespeed')
          .set(a())
          .send({ url: `https://${otherHost}/` })
      ).status,
    ).toBe(400);
    await drain(tenantProject);
    const list = await http().get('/seo-advanced/pagespeed').set(a());
    expect(list.status).toBe(200);
    expect(list.body.keyConfigured).toBe(false);
    const home = (
      list.body.urls as {
        url: string;
        mobile: { scores: { performance: number }; field: unknown };
      }[]
    ).find((u) => u.url === `https://${tenantHost}/`);
    expect(home?.mobile.scores.performance).toBeGreaterThan(0);
    expect(home?.mobile.field).toMatchObject({ scope: 'url', overall: 'FAST' });

    // Una página lenta para los usuarios reales y otra cuya puntuación cae: alertas.
    await http()
      .post('/seo-advanced/pagespeed')
      .set(a())
      .send({ url: '/slow', strategies: ['mobile'] });
    await withAdminDb((db) =>
      db.seoPageSpeedRun.create({
        data: {
          tenantId: owner.tenantId,
          projectId: tenantProject,
          url: `https://${tenantHost}/caida`,
          urlKey: `${tenantHost}/caida`,
          strategy: 'mobile',
          status: 'done',
          trigger: 'manual',
          performanceScore: 99,
          analyzedAt: new Date(Date.now() - 7 * 86_400_000),
        },
      }),
    );
    await http()
      .post('/seo-advanced/pagespeed')
      .set(a())
      .send({ url: '/caida', strategies: ['mobile'] });
    await drain(tenantProject);
    await http().post('/seo-advanced/alerts/check').set(a());
    const alerts = await http().get('/seo-advanced/alerts').query({ status: 'live' }).set(a());
    const types = (alerts.body.items as { type: string }[]).map((x) => x.type);
    expect(types).toContain('pagespeed_slow');
    expect(types).toContain('pagespeed_drop');
    const hist = await http()
      .get('/seo-advanced/pagespeed/history')
      .query({ url: '/caida', strategy: 'mobile' })
      .set(a());
    expect(hist.body.runs).toHaveLength(2);

    // Semanal (plataforma): portada, URL objetivo importante y páginas de más clics, con tope.
    const base = `/admin/seo/projects/${platformProject}`;
    await http().put(`${base}/technical/settings`).set(asSuper()).send({ pagespeedMaxUrls: 2 });
    expect(await pagespeed.enqueueWeekly(platformProject)).toBe(4);
    await drain(platformProject);
    // Otra semana: el histórico se conserva.
    expect(await pagespeed.enqueueWeekly(platformProject)).toBe(4);
    await drain(platformProject);
    const weekly = await http()
      .get(`${base}/pagespeed/history`)
      .query({ url: '/', strategy: 'mobile' })
      .set(asSupport());
    expect(weekly.status).toBe(200);
    expect(weekly.body.runs).toHaveLength(2);
    expect(
      (await http().post(`${base}/pagespeed`).set(asSupport()).send({ url: '/' })).status,
    ).toBe(403);
    // El otro negocio no ve las mediciones.
    expect((await http().get('/seo-advanced/pagespeed').set(b())).body.urls).toEqual([]);
  });
});
