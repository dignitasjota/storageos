import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { PrismaService } from '../src/modules/database/prisma.service';
import { SeoGscSyncService } from '../src/modules/seo-advanced/seo-gsc-sync.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-advanced-super@storageos.local';
const SUPPORT_EMAIL = 'seo-advanced-support@storageos.local';
const PLATFORM_PREFIX = 'E2E SEO ';
const GRAINS = [
  'site',
  'device',
  'country',
  'search_type',
  'query',
  'page',
  'query_page',
  'query_device',
  'query_country',
  'page_device',
];
/** Días de la carga inicial en los tests (`env-setup.ts`). */
const INITIAL_DAYS = 20;

const yesterday = () => shiftDate(new Date().toISOString().slice(0, 10), -1);

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

async function cleanupPlatformProjects(): Promise<void> {
  await withAdminDb((db) =>
    db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PLATFORM_PREFIX } } }),
  );
}

/** Espera a que la descarga termine (la procesa la cola del propio API). */
async function waitRun(runId: string): Promise<{ status: string; daysDone: number }> {
  for (let i = 0; i < 120; i++) {
    const run = await withAdminDb((db) => db.seoSyncRun.findUnique({ where: { id: runId } }));
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`la descarga ${runId} no terminó`);
}

/** Espera a que el tenant no tenga descargas en cola ni en curso. */
async function waitIdle(tenantId: string): Promise<void> {
  for (let i = 0; i < 160; i++) {
    const n = await withAdminDb((db) =>
      db.seoSyncRun.count({ where: { tenantId, status: { in: ['queued', 'running'] } } }),
    );
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('las descargas del tenant no terminaron');
}

async function countsByGrain(domainId: string): Promise<Record<string, number>> {
  const rows = await withAdminDb((db) =>
    db.seoGscMetric.groupBy({ by: ['grain'], where: { domainId }, _count: { _all: true } }),
  );
  return Object.fromEntries(rows.map((r) => [r.grain, r._count._all]));
}

describe('SEO Avanzado: proyectos, dominios y Search Console (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let platformProjectId = '';
  let platformDomainId = '';

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupPlatformProjects();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super SEO', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte SEO', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatformProjects();
    await withAdminDb((db) =>
      db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } }),
    );
    await cleanupTestTenants();
  });

  it('plataforma: alta, dominio, descarga de todos los cruces sin duplicar y resumen', async () => {
    // El soporte solo lee.
    expect(
      (await http().post('/admin/seo/projects').set(asSupport()).send({ name: 'x proyecto' }))
        .status,
    ).toBe(403);

    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PLATFORM_PREFIX}plataforma`, strategy: 'national' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      tenantId: null,
      country: 'ES',
      language: 'es',
      strategy: 'national',
      status: 'active',
      domains: [],
    });
    expect(created.body.weights.impressions).toBeGreaterThan(0);
    platformProjectId = created.body.id;

    const props = await http().get('/admin/seo/properties').set(asSupport());
    expect(props.status).toBe(200);
    expect(props.body.available).toBe(true);
    expect(props.body.serviceAccountEmail).toContain('@');
    expect(props.body.properties.map((p: { siteUrl: string }) => p.siteUrl)).toContain(
      'sc-domain:trasteros.pro',
    );

    // La plataforma puede conectar cualquier propiedad con acceso.
    const added = await http()
      .post(`/admin/seo/projects/${platformProjectId}/domains`)
      .set(asSuper())
      .send({ gscProperty: 'sc-domain:E2E-plataforma.es' });
    expect(added.status).toBe(201);
    const domain = added.body.domains[0];
    expect(domain).toMatchObject({
      domain: 'e2e-plataforma.es',
      role: 'primary',
      connectionStatus: 'connected',
      initialDone: false,
    });
    expect(domain.activeRun.kind).toBe('initial');
    platformDomainId = domain.id;

    const initial = await waitRun(domain.activeRun.id);
    expect(initial).toMatchObject({ status: 'done', daysDone: INITIAL_DAYS });
    const counts = await countsByGrain(platformDomainId);
    for (const grain of GRAINS) expect(counts[grain] ?? 0).toBeGreaterThan(0);
    // Un día por fila en el cruce del sitio; dos dispositivos.
    expect(counts.site).toBe(INITIAL_DAYS);
    expect(counts.device).toBe(INITIAL_DAYS * 2);

    const detail = await http().get(`/admin/seo/projects/${platformProjectId}`).set(asSupport());
    expect(detail.body.domains[0]).toMatchObject({
      initialDone: true,
      dataUntil: yesterday(),
      delayed: false,
      activeRun: null,
    });

    // Repetirla no duplica nada.
    const manual = await http()
      .post(`/admin/seo/projects/${platformProjectId}/domains/${platformDomainId}/sync`)
      .set(asSuper());
    expect(manual.status).toBe(201);
    expect(manual.body.kind).toBe('manual');
    expect((await waitRun(manual.body.id)).status).toBe('done');
    expect(await countsByGrain(platformDomainId)).toEqual(counts);

    // El soporte no lanza descargas.
    expect(
      (
        await http()
          .post(`/admin/seo/projects/${platformProjectId}/domains/${platformDomainId}/sync`)
          .set(asSupport())
      ).status,
    ).toBe(403);

    // Resumen de 7 días: 7 clics y 110 impresiones al día en la web simulada.
    const summary = await http()
      .get(`/admin/seo/projects/${platformProjectId}/summary?days=7`)
      .set(asSupport());
    expect(summary.status).toBe(200);
    const s = summary.body;
    expect(s).toMatchObject({ domain: 'e2e-plataforma.es', days: 7, lastDate: yesterday() });
    expect(s.current).toMatchObject({ clicks: 49, impressions: 770, ctr: 0.064 });
    // Posición media ponderada por impresiones, con lo guardado.
    const siteRows = await withAdminDb((db) =>
      db.seoGscMetric.findMany({
        where: {
          domainId: platformDomainId,
          grain: 'site',
          date: { gte: new Date(`${s.from}T00:00:00Z`), lte: new Date(`${s.to}T00:00:00Z`) },
        },
      }),
    );
    const weighted =
      siteRows.reduce((n, r) => n + Number(r.position) * r.impressions, 0) /
      siteRows.reduce((n, r) => n + r.impressions, 0);
    expect(s.current.position).toBe(Math.round(weighted * 10) / 10);
    expect(s.previous).toMatchObject({ clicks: 49, impressions: 770 });
    expect(s.change).toMatchObject({ clicksPct: 0, impressionsPct: 0, positionDiff: 0 });
    // 15 impresiones y 1 clic al día que Google no detalla por búsqueda.
    expect(s.undetailed).toEqual({ clicks: 7, impressions: 105, impressionsShare: 0.136 });
    expect(s.devices.map((d: { device: string }) => d.device).sort()).toEqual([
      'DESKTOP',
      'MOBILE',
    ]);
    expect(s.daily).toHaveLength(7);

    const runs = await http().get(`/admin/seo/projects/${platformProjectId}/runs`).set(asSupport());
    expect(runs.body.map((r: { kind: string }) => r.kind)).toEqual(['manual', 'initial']);
    expect(runs.body[0].createdBy).toBe('Super SEO');
  });

  it('una descarga interrumpida sigue desde su cursor', async () => {
    const to = yesterday();
    const from = shiftDate(to, -9);
    const cursor = shiftDate(to, -4);
    const run = await withAdminDb(async (db) => {
      // Lo de los últimos días «ya estaba»: se borra para ver qué se vuelve a pedir.
      await db.seoGscMetric.deleteMany({
        where: {
          domainId: platformDomainId,
          grain: 'query',
          date: { gte: new Date(`${from}T00:00:00Z`) },
        },
      });
      return db.seoSyncRun.create({
        data: {
          projectId: platformProjectId,
          domainId: platformDomainId,
          kind: 'manual',
          status: 'running',
          rangeFrom: new Date(`${from}T00:00:00Z`),
          rangeTo: new Date(`${to}T00:00:00Z`),
          daysTotal: 10,
          daysDone: 5,
          totalsDone: true,
          cursor: new Date(`${cursor}T00:00:00Z`),
        },
      });
    });
    await app.get(SeoGscSyncService).processRun(run.id);
    const after = await withAdminDb((db) => db.seoSyncRun.findUnique({ where: { id: run.id } }));
    expect(after).toMatchObject({ status: 'done', daysDone: 10 });
    expect(after!.cursor!.toISOString().slice(0, 10)).toBe(from);
    const dates = await withAdminDb((db) =>
      db.seoGscMetric.findMany({
        where: {
          domainId: platformDomainId,
          grain: 'query',
          date: { gte: new Date(`${from}T00:00:00Z`) },
        },
        distinct: ['date'],
        select: { date: true },
        orderBy: { date: 'asc' },
      }),
    );
    // Solo los cinco días que faltaban.
    expect(dates.map((d) => d.date.toISOString().slice(0, 10))).toEqual([
      from,
      shiftDate(from, 1),
      shiftDate(from, 2),
      shiftDate(from, 3),
      shiftDate(from, 4),
    ]);
  });

  it('tenant: con el extra (incluye SEO local), su web, límites y aislamiento', async () => {
    const owner = await registerVerifiedUser(app, 'seoadvone');
    const a = { Authorization: `Bearer ${owner.accessToken}` };

    const locked = await http().get('/seo-advanced').set(a);
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe('feature_not_in_plan');

    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    const me = await http().get('/auth/me').set(a);
    expect(me.body.features).toEqual(expect.arrayContaining(['seo_advanced', 'local_seo']));
    // SEO local queda incluido.
    expect((await http().get('/seo/search-console').set(a)).status).toBe(200);

    await setVerifiedCustomDomain(owner.slug, `tienda.${owner.slug}.es`);
    const empty = await http().get('/seo-advanced').set(a);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      project: null,
      available: true,
      suggestedProperty: `sc-domain:tienda.${owner.slug}.es`,
      limits: { primaryDomains: 1, secondaryDomains: 3 },
    });

    // Sin proyecto, el resto de rutas dan 404.
    expect((await http().get('/seo-advanced/runs').set(a)).status).toBe(404);

    const created = await http().post('/seo-advanced/project').set(a).send({});
    expect(created.status).toBe(201);
    expect(created.body.name).toBeTruthy();
    expect(created.body.tenantId).toBe(owner.tenantId);
    const primary = created.body.domains[0];
    expect(primary).toMatchObject({
      domain: `tienda.${owner.slug}.es`,
      role: 'primary',
      connectionStatus: 'connected',
    });
    expect((await http().post('/seo-advanced/project').set(a).send({})).body.code).toBe(
      'seo_project_exists',
    );

    // Una web ajena: ni se guarda.
    const foreign = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: 'sc-domain:competidor.es' });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('seo_property_not_yours');
    // Ni la de la plataforma.
    expect(
      (
        await http()
          .post('/seo-advanced/domains')
          .set(a)
          .send({ gscProperty: 'sc-domain:e2e-plataforma.es' })
      ).body.code,
    ).toBe('seo_property_not_yours');

    // Un solo principal.
    const second = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: `sc-domain:${owner.slug}.es`, role: 'primary' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('seo_primary_exists');

    // El dominio superior es suyo: secundario.
    const secondary = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: `sc-domain:${owner.slug}.es` });
    expect(secondary.status).toBe(201);
    expect(secondary.body.domains).toHaveLength(2);
    expect(secondary.body.domains[1]).toMatchObject({ role: 'secondary' });

    // Límite: 1 principal + 3 más (se rellenan dos a mano para llegar).
    await withAdminDb((db) =>
      db.seoProjectDomain.createMany({
        data: ['uno', 'dos'].map((n) => ({
          tenantId: owner.tenantId,
          projectId: created.body.id,
          domain: `${n}.${owner.slug}.es`,
          role: 'redirect',
          gscProperty: `sc-domain:${n}.${owner.slug}.es`,
        })),
      }),
    );
    await withAdminDb((db) =>
      db.tenantEmailDomain.create({
        data: {
          tenantId: owner.tenantId,
          domain: `${owner.slug}-correo.es`,
          ownershipToken: 'e2e',
          ownershipVerifiedAt: new Date(),
        },
      }),
    );
    const overLimit = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: `sc-domain:${owner.slug}-correo.es` });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.code).toBe('seo_domain_limit');

    // Otro tenant con el extra no ve nada de este ni de la plataforma.
    const other = await registerVerifiedUser(app, 'seoadvtwo');
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(other.slug, 'seo_advanced', true);
    expect((await http().get('/seo-advanced').set(b)).body.project).toBeNull();
    const runs = await http().get('/seo-advanced/runs').set(a);
    expect(runs.status).toBe(200);
    expect((await http().post(`/seo-advanced/runs/${runs.body[0].id}/cancel`).set(b)).status).toBe(
      404,
    );
    await http().post('/seo-advanced/project').set(b).send({ name: 'Otro negocio' });
    expect((await http().delete(`/seo-advanced/domains/${primary.id}`).set(b)).status).toBe(404);

    // La política de filas: el rol de la app no ve lo de la plataforma ni lo de otros.
    const prisma = app.get(PrismaService);
    const visible = await prisma.withTenant(
      (tx) => tx.seoProject.findMany({ select: { id: true, tenantId: true } }),
      owner.tenantId,
    );
    expect(visible.map((p) => p.tenantId)).toEqual([owner.tenantId]);
    const platformRows = await prisma.withTenant(
      (tx) => tx.seoGscMetric.count({ where: { domainId: platformDomainId } }),
      owner.tenantId,
    );
    expect(platformRows).toBe(0);

    // El super admin ve los proyectos de los tenants, sin poder cambiarlos.
    const list = await http().get('/admin/seo/tenant-projects').set(asSupport());
    const row = list.body.find((p: { id: string }) => p.id === created.body.id);
    expect(row).toMatchObject({ tenantSlug: owner.slug, featureEnabled: true });
    expect(
      (await http().get('/admin/seo/projects').set(asSuper())).body.some(
        (p: { id: string }) => p.id === created.body.id,
      ),
    ).toBe(false);
    expect(
      (
        await http()
          .patch(`/admin/seo/projects/${created.body.id}`)
          .set(asSuper())
          .send({ name: 'Cambio' })
      ).status,
    ).toBe(404);

    // Su carga inicial y su resumen.
    await waitRun(primary.activeRun.id);
    const summary = await http().get('/seo-advanced/summary?days=28').set(a);
    expect(summary.status).toBe(200);
    expect(summary.body.domain).toBe(`tienda.${owner.slug}.es`);
    expect(summary.body.current.clicks).toBe(7 * INITIAL_DAYS);
    // Con 20 días no hay 28 anteriores completos: no se compara.
    expect(summary.body.previous).toBeNull();

    // Sin el extra, deja de funcionar y la descarga diaria lo salta.
    await waitIdle(owner.tenantId);
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', false);
    expect((await http().get('/seo-advanced').set(a)).status).toBe(403);
    const daily = await app.get(SeoGscSyncService).enqueueDailyAll();
    expect(daily.domains).toBeGreaterThan(0);
    const queued = await withAdminDb((db) =>
      db.seoSyncRun.count({
        where: { tenantId: owner.tenantId, status: { in: ['queued', 'running'] } },
      }),
    );
    expect(queued).toBe(0);
  });

  it('migración desde «SEO local»: proyecto, dominio y lo ya descargado', async () => {
    const owner = await registerVerifiedUser(app, 'seoadvmig');
    const d1 = new Date('2026-10-01T00:00:00Z');
    const d2 = new Date('2026-10-02T00:00:00Z');
    await withAdminDb(async (db) => {
      await db.tenantSearchConsole.create({
        data: {
          tenantId: owner.tenantId,
          siteUrl: `https://www.${owner.slug}.es/`,
          status: 'connected',
          brandTerms: ['guardalo'],
        },
      });
      await db.searchConsoleDay.createMany({
        data: [
          { tenantId: owner.tenantId, date: d1, clicks: 10, impressions: 100, position: 4.5 },
          { tenantId: owner.tenantId, date: d2, clicks: 0, impressions: 0, position: 0 },
        ],
      });
      await db.searchConsoleDevice.createMany({
        data: [
          {
            tenantId: owner.tenantId,
            date: d1,
            device: 'MOBILE',
            clicks: 7,
            impressions: 70,
            position: 4,
          },
          {
            tenantId: owner.tenantId,
            date: d1,
            device: 'DESKTOP',
            clicks: 3,
            impressions: 30,
            position: 5,
          },
        ],
      });
      await db.searchConsoleRow.create({
        data: {
          tenantId: owner.tenantId,
          date: d1,
          query: 'trasteros',
          page: `https://www.${owner.slug}.es/`,
          clicks: 8,
          impressions: 80,
          position: 4.2,
        },
      });
    });

    const migrated = await withAdminDb(async (db) => {
      await db.$queryRaw`SELECT seo_migrate_search_console()`;
      // Repetirla no crea otro proyecto.
      await db.$queryRaw`SELECT seo_migrate_search_console()`;
      return db.seoProject.findMany({
        where: { tenantId: owner.tenantId },
        include: { domains: true },
      });
    });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.brandTerms).toEqual(['guardalo']);
    const domain = migrated[0]!.domains[0]!;
    expect(domain).toMatchObject({
      domain: `${owner.slug}.es`,
      role: 'primary',
      gscProperty: `https://www.${owner.slug}.es/`,
      connectionStatus: 'connected',
      initialDoneAt: null,
    });
    expect(domain.dataUntil!.toISOString().slice(0, 10)).toBe('2026-10-02');
    expect(await countsByGrain(domain.id)).toEqual({ site: 2, device: 2, query_page: 1 });
    const qp = await withAdminDb((db) =>
      db.seoGscMetric.findFirst({ where: { domainId: domain.id, grain: 'query_page' } }),
    );
    expect(qp).toMatchObject({
      query: 'trasteros',
      clicks: 8,
      impressions: 80,
      tenantId: owner.tenantId,
    });
    expect(Number(qp!.ctr)).toBe(0.1);
    // Las tablas antiguas siguen ahí.
    expect(
      await withAdminDb((db) => db.searchConsoleDay.count({ where: { tenantId: owner.tenantId } })),
    ).toBe(2);
  });
});
