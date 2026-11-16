import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Posiciones con Search Console (simulado en tests). Extra «SEO local». */
describe('Search Console (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('conecta la propiedad, descarga las búsquedas y resume las posiciones', async () => {
    const owner = await registerVerifiedUser(app, 'gscconnect');
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());

    // Sin el extra no está disponible.
    expect((await http().get('/seo/search-console').set(a)).status).toBe(403);
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);
    // Su web: el dominio propio (en la simulación, con «noaccess» no hay acceso).
    await setVerifiedCustomDomain(owner.slug, `www.noaccess.${owner.slug}.es`);

    const empty = await http().get('/seo/search-console').set(a);
    expect(empty.body).toMatchObject({ available: true, siteUrl: null, status: null });
    expect(empty.body.serviceAccountEmail).toContain('@');

    // Formato de propiedad inválido.
    expect(
      (await http().put('/seo/search-console').set(a).send({ siteUrl: 'guardalo.es' })).status,
    ).toBe(400);

    // Un sitio que no es su web: ni se guarda.
    const foreign = await http()
      .put('/seo/search-console')
      .set(a)
      .send({ siteUrl: 'sc-domain:competidor.es' });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('search_console_site_not_yours');
    expect((await http().get('/seo/search-console').set(a)).body.siteUrl).toBeNull();

    // Sin acceso: queda en error con el motivo.
    const denied = await http()
      .put('/seo/search-console')
      .set(a)
      .send({ siteUrl: `sc-domain:noaccess.${owner.slug}.es` });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('search_console_no_access');
    expect((await http().get('/seo/search-console').set(a)).body.status).toBe('error');

    // Con acceso (el dominio superior también es suyo): conecta y descarga.
    const ok = await http()
      .put('/seo/search-console')
      .set(a)
      .send({ siteUrl: `sc-domain:${owner.slug}.es` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      siteUrl: `sc-domain:${owner.slug}.es`,
      status: 'connected',
      lastError: null,
    });
    expect(ok.body.lastSyncedAt).not.toBeNull();

    const pos = await http().get('/seo/positions?days=28').set(a);
    expect(pos.status).toBe(200);
    expect(pos.body.totals.clicks).toBe(28 * 6);
    expect(pos.body.queries.map((q: { query: string }) => q.query)).toContain('trasteros mislata');
    const zone = pos.body.pages.find((p: { areaSlug: string | null }) => p.areaSlug === 'mislata');
    expect(zone).toMatchObject({ path: '/trasteros-en-mislata', position: 3.2 });

    // Repetir la descarga no duplica filas.
    await http().post('/seo/search-console/sync').set(a).expect(201);
    expect((await http().get('/seo/positions?days=28').set(a)).body.totals.clicks).toBe(28 * 6);

    // Desconectar borra los datos.
    const off = await http().delete('/seo/search-console').set(a);
    expect(off.body).toMatchObject({ siteUrl: null, status: null });
    expect((await http().get('/seo/positions').set(a)).body.totals.clicks).toBe(0);
  });

  it('informe mensual: resumen del mes pasado, consejos, envío y desactivar', async () => {
    const owner = await registerVerifiedUser(app, 'gscreport');
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);
    await setVerifiedCustomDomain(owner.slug, `${owner.slug}.es`);
    await http()
      .put('/seo/search-console')
      .set(a)
      .send({ siteUrl: `sc-domain:${owner.slug}.es` })
      .expect(200);

    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const daysInPrev = new Date(
      Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0),
    ).getUTCDate();

    const report = await http().get('/seo/report').set(a);
    expect(report.status).toBe(200);
    expect(report.body.month).toBe(prev.toISOString().slice(0, 7));
    expect(report.body.summary.totals.clicks).toBe(daysInPrev * 6);
    expect(Array.isArray(report.body.tips)).toBe(true);
    // «alquiler trasteros» sale en la posición 9 con apariciones: es una oportunidad.
    expect(report.body.summary.opportunities.map((q: { query: string }) => q.query)).toContain(
      'alquiler trasteros',
    );

    expect((await http().get('/seo/report?month=2026-13').set(a)).status).toBe(400);

    const sent = await http().post('/seo/report/send').set(a);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ recipients: 1, month: report.body.month });

    const off = await http().put('/seo/search-console/report').set(a).send({ enabled: false });
    expect(off.body.monthlyReport).toBe(false);
  });

  it('un sitio conectado antes en otro negocio: el dueño no queda bloqueado y el otro deja de descargar', async () => {
    const http = () => request(app.getHttpServer());
    const intruder = await registerVerifiedUser(app, 'gscintruder');
    const owner = await registerVerifiedUser(app, 'gscowner');
    await setTenantFeatureOverride(intruder.slug, 'local_seo', true);
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);
    await setVerifiedCustomDomain(owner.slug, `${owner.slug}.es`);
    const site = `sc-domain:${owner.slug}.es`;
    // Conexión de antes de comprobar que el sitio es del negocio.
    await withAdminDb(async (db) => {
      const t = await db.tenant.findUniqueOrThrow({ where: { slug: intruder.slug } });
      await db.tenantSearchConsole.create({
        data: { tenantId: t.id, siteUrl: site, status: 'connected', connectedAt: new Date() },
      });
    });
    const intruderAuth = { Authorization: `Bearer ${intruder.accessToken}` };
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // El sitio ya está en otra cuenta: el dueño lo ve y tiene que escribirnos.
    const taken = await http().put('/seo/search-console').set(ownerAuth).send({ siteUrl: site });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('search_console_site_taken');

    // La descarga del intruso se para con el motivo y no trae datos.
    await http().post('/seo/search-console/sync').set(intruderAuth).expect(201);
    const after = (await http().get('/seo/search-console').set(intruderAuth)).body;
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('no es tu web');
    expect((await http().get('/seo/positions').set(intruderAuth)).body.totals.clicks).toBe(0);
  });
});
