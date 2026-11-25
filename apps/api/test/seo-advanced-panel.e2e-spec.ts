import { hash as argonHash } from '@node-rs/argon2';
import { seoShiftYears, shiftDate } from '@storageos/shared';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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

const SUPER_EMAIL = 'seo-panel-super@storageos.local';
const SUPPORT_EMAIL = 'seo-panel-support@storageos.local';
const PLATFORM_PREFIX = 'E2E SEO panel ';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const yesterday = () => shiftDate(new Date().toISOString().slice(0, 10), -1);
/** Día relativo a ayer (0 = ayer, -1 = anteayer…). */
const dayAt = (offset: number) => shiftDate(yesterday(), offset);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => dayAt(from + i));

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/** Espera a que no queden descargas en cola ni en curso de ese dueño. */
async function waitIdle(where: { tenantId: string | null; projectId?: string }): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = await withAdminDb((db) =>
      db.seoSyncRun.count({ where: { ...where, status: { in: ['queued', 'running'] } } }),
    );
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('las descargas no terminaron');
}

/** Un Excel como el de Search Console (cada pestaña, una hoja). */
async function xlsx(sheets: Record<string, (string | number)[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function zipOfCsv(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('SEO Avanzado: dominio secundario, Excel históricos y panel (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });

  let a: { Authorization: string };
  let b: { Authorization: string };
  let tenantA: { tenantId: string; slug: string };
  let projectA = '';
  let primaryA = '';
  let platformProject = '';
  let platformDomain = '';
  let externalDomain = '';
  let importEs = '';

  beforeAll(async () => {
    await cleanupTestTenants();
    await withAdminDb((db) =>
      db.seoProject.deleteMany({
        where: { tenantId: null, name: { startsWith: PLATFORM_PREFIX } },
      }),
    );
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super panel', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte panel', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    // La plataforma con un dominio y su carga inicial (20 días simulados).
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PLATFORM_PREFIX}plataforma` });
    platformProject = created.body.id;
    const added = await http()
      .post(`/admin/seo/projects/${platformProject}/domains`)
      .set(asSuper())
      .send({ gscProperty: 'sc-domain:e2e-panel.es' });
    platformDomain = added.body.domains[0].id;

    // Tenant A con el extra, su dominio propio y su proyecto.
    const owner = await registerVerifiedUser(app, 'seopanela');
    tenantA = owner;
    a = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `tienda.${owner.slug}.es`);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    projectA = project.body.id;
    primaryA = project.body.domains[0].id;

    const other = await registerVerifiedUser(app, 'seopanelb');
    b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(other.slug, 'seo_advanced', true);
    await http().post('/seo-advanced/project').set(b).send({});

    await waitIdle({ tenantId: null, projectId: platformProject });
    await waitIdle({ tenantId: owner.tenantId });
    await waitIdle({ tenantId: other.tenantId });
  });

  afterAll(async () => {
    await app.close();
    await withAdminDb((db) =>
      db.seoProject.deleteMany({
        where: { tenantId: null, name: { startsWith: PLATFORM_PREFIX } },
      }),
    );
    await withAdminDb((db) =>
      db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } }),
    );
    await cleanupTestTenants();
  });

  it('dominio secundario: con acceso y libre se acepta; el resto, con su motivo', async () => {
    const external = `sc-domain:mislata-${tenantA.slug}.es`;

    // Como principal, no: el principal tiene que ser suyo.
    const asPrimary = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: external, role: 'primary' });
    expect(asPrimary.status).toBe(400);
    expect(asPrimary.body.code).toBe('seo_primary_not_yours');

    // Sin acceso de nuestra cuenta en Search Console.
    const noAccess = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: `sc-domain:noaccess-${tenantA.slug}.es` });
    expect(noAccess.status).toBe(400);
    expect(noAccess.body.code).toBe('seo_property_no_access');
    expect(noAccess.body.message).toContain('Usuarios y permisos');

    // Un dominio de la plataforma (y sus subdominios).
    const platform = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: 'sc-domain:mail.storageos.local' });
    expect(platform.status).toBe(400);
    expect(platform.body.code).toBe('seo_property_platform');

    // Uno que ya usa un proyecto de la plataforma.
    const platformTaken = await http()
      .post('/seo-advanced/domains')
      .set(a)
      .send({ gscProperty: 'sc-domain:e2e-panel.es' });
    expect(platformTaken.status).toBe(409);
    expect(platformTaken.body.code).toBe('seo_property_taken');

    // El bueno: secundario, verificado por el acceso, conectado y descargando.
    const ok = await http().post('/seo-advanced/domains').set(a).send({ gscProperty: external });
    expect(ok.status).toBe(201);
    const domain = ok.body.domains.find(
      (d: { domain: string }) => d.domain === `mislata-${tenantA.slug}.es`,
    );
    expect(domain).toMatchObject({
      role: 'secondary',
      verification: 'gsc_access',
      connectionStatus: 'connected',
    });
    expect(domain.activeRun.kind).toBe('initial');
    externalDomain = domain.id;

    // Otro tenant ya no lo puede usar.
    const taken = await http().post('/seo-advanced/domains').set(b).send({ gscProperty: external });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('seo_property_taken');

    // No se puede pasar a principal.
    const promote = await http()
      .patch(`/seo-advanced/domains/${externalDomain}`)
      .set(a)
      .send({ role: 'primary' });
    expect(promote.status).toBe(400);
    expect(promote.body.code).toBe('seo_primary_not_yours');

    // Comprobarlo otra vez sigue valiendo.
    await waitIdle({ tenantId: tenantA.tenantId });
    const checked = await http().post(`/seo-advanced/domains/${externalDomain}/check`).set(a);
    expect(checked.status).toBe(201);
    await waitIdle({ tenantId: tenantA.tenantId });
  });

  it('importa un Excel en español: vista previa, días nuevos y la API manda', async () => {
    // Fechas de −24 a −15: los cinco primeros no los tiene la API (que va de −19 a 0).
    const file = await xlsx({
      Consultas: [
        ['Consultas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['trasteros baratos', 20, 400, '5 %', '7,5'],
        ['guardamuebles', 10, 100, '10 %', '3'],
      ],
      Páginas: [
        ['Páginas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        [`https://tienda.${tenantA.slug}.es/`, 30, 500, '6 %', '6'],
      ],
      Países: [
        ['País', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['España', 28, 480, '5,83 %', '6'],
      ],
      Dispositivos: [
        ['Dispositivo', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['Móvil', 20, 300, '6,67 %', '5'],
        ['Ordenador', 10, 200, '5 %', '7'],
      ],
      Fechas: [
        ['Fecha', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ...range(-24, -15).map((d) => [d, 2, 50, '4 %', '8']),
      ],
      Filtros: [
        ['Filtro', 'Valor'],
        ['Tipo de búsqueda', 'Web'],
        ['Fecha', 'Personalizado'],
      ],
    });
    const upload = (path: string, buf: Buffer, name: string, headers = a) =>
      http()
        .post(path)
        .set(headers)
        .field('domainId', primaryA)
        .attach('file', buf, { filename: name, contentType: XLSX });

    const preview = await upload('/seo-advanced/imports/preview', file, 'export.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      format: 'xlsx',
      language: 'es',
      periodFrom: dayAt(-24),
      periodTo: dayAt(-15),
      filtered: false,
      siteDaysApi: 5,
      siteDaysImported: 0,
      siteDaysToAdd: 5,
      tabRows: { query: 2, page: 1, country: 1, device: 2, date: 10 },
    });

    const created = await upload('/seo-advanced/imports', file, 'export.xlsx');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ siteDaysAdded: 5, siteDaysApi: 5, filtered: false });
    importEs = created.body.id;

    const rows = await withAdminDb((db) =>
      db.seoGscMetric.findMany({
        where: {
          domainId: primaryA,
          grain: 'site',
          date: { lte: new Date(`${dayAt(-15)}T00:00:00Z`) },
        },
        orderBy: { date: 'asc' },
      }),
    );
    // Los cinco días nuevos, del Excel; los de la API, intactos.
    const imported = rows.filter((r) => r.source === 'import');
    expect(imported.map((r) => r.date.toISOString().slice(0, 10))).toEqual(range(-24, -20));
    expect(imported.every((r) => r.importId === importEs && r.clicks === 2)).toBe(true);
    const api = rows.filter((r) => r.source === 'api');
    expect(api.length).toBe(5);
    expect(api.every((r) => r.clicks === 7 && r.impressions === 110)).toBe(true);

    // El mismo fichero no entra dos veces.
    const again = await upload('/seo-advanced/imports', file, 'otra-vez.xlsx');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('seo_import_duplicate');
    expect((await upload('/seo-advanced/imports/preview', file, 'x.xlsx')).status).toBe(409);

    // La vista de la importación: sus pestañas, con totales recalculados.
    const detail = await http().get(`/seo-advanced/imports/${importEs}`).set(a);
    expect(detail.status).toBe(200);
    const queries = detail.body.tabs.find((t: { dimension: string }) => t.dimension === 'query');
    expect(queries.rows[0]).toMatchObject({ value: 'trasteros baratos', clicks: 20, ctr: 0.05 });
    // (7,5·400 + 3·100) / 500 = 6,6
    expect(queries.totals).toEqual({ clicks: 30, impressions: 500, ctr: 0.06, position: 6.6 });
    const devices = detail.body.tabs.find((t: { dimension: string }) => t.dimension === 'device');
    expect(devices.rows.map((r: { value: string }) => r.value)).toEqual(['MOBILE', 'DESKTOP']);

    // Un fichero que no es de Search Console.
    const bad = await upload(
      '/seo-advanced/imports/preview',
      Buffer.from('hola, esto no es un excel'),
      'x.xlsx',
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('seo_import_invalid');
  });

  it('Excel en inglés con filtro de país (avisado y sin tocar los totales) y zip de CSV', async () => {
    const filtered = await xlsx({
      Queries: [
        ['Top queries', 'Clicks', 'Impressions', 'CTR', 'Position'],
        ['storage units', 5, 80, '6.25%', '9.1'],
      ],
      Dates: [
        ['Date', 'Clicks', 'Impressions', 'CTR', 'Position'],
        ...range(-40, -36).map((d) => [d, 1, 10, '10%', '9']),
      ],
      Filters: [
        ['Filter', 'Value'],
        ['Search type', 'Web'],
        ['Country', 'France'],
      ],
    });
    const preview = await http()
      .post('/seo-advanced/imports/preview')
      .set(a)
      .field('domainId', primaryA)
      .attach('file', filtered, { filename: 'export-en.xlsx', contentType: XLSX });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ language: 'en', filtered: true, siteDaysToAdd: 0 });
    expect(preview.body.filterReasons[0]).toContain('Country: France');
    const created = await http()
      .post('/seo-advanced/imports')
      .set(a)
      .field('domainId', primaryA)
      .attach('file', filtered, { filename: 'export-en.xlsx', contentType: XLSX });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ filtered: true, siteDaysAdded: 0 });
    expect(
      await withAdminDb((db) => db.seoGscMetric.count({ where: { importId: created.body.id } })),
    ).toBe(0);

    // Zip de CSV (como lo da Google): −27 a −22; −24 a −22 ya vienen del Excel.
    const csv = (rows: (string | number)[][]) => rows.map((r) => r.join(',')).join('\n');
    const zip = await zipOfCsv({
      'Consultas.csv': csv([
        ['Consultas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['trasteros', 4, 40, '10%', '4.5'],
      ]),
      'Fechas.csv': csv([
        ['Fecha', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ...range(-27, -22).map((d) => [d, 3, 30, '10%', '5']),
      ]),
      'Filtros.csv': csv([
        ['Filtro', 'Valor'],
        ['Tipo de búsqueda', 'Web'],
      ]),
    });
    const zipPreview = await http()
      .post('/seo-advanced/imports/preview')
      .set(a)
      .field('domainId', primaryA)
      .attach('file', zip, { filename: 'export.zip', contentType: 'application/zip' });
    expect(zipPreview.status).toBe(200);
    expect(zipPreview.body).toMatchObject({
      format: 'zip',
      siteDaysApi: 0,
      siteDaysImported: 3,
      siteDaysToAdd: 3,
    });
    const zipped = await http()
      .post('/seo-advanced/imports')
      .set(a)
      .field('domainId', primaryA)
      .attach('file', zip, { filename: 'export.zip', contentType: 'application/zip' });
    expect(zipped.status).toBe(201);
    expect(zipped.body.siteDaysAdded).toBe(3);

    const list = await http().get('/seo-advanced/imports').set(a);
    expect(list.body).toHaveLength(3);
    expect(list.body[0].createdBy).toBeTruthy();

    // Borrar una importación quita sus filas y sus días.
    expect((await http().delete(`/seo-advanced/imports/${zipped.body.id}`).set(a)).status).toBe(
      204,
    );
    expect(
      await withAdminDb((db) => db.seoGscMetric.count({ where: { importId: zipped.body.id } })),
    ).toBe(0);
    expect(
      await withAdminDb((db) => db.seoGscImportRow.count({ where: { importId: zipped.body.id } })),
    ).toBe(0);
    expect((await http().get('/seo-advanced/imports').set(a)).body).toHaveLength(2);

    // Otro tenant no ve ni borra lo de este.
    expect((await http().get(`/seo-advanced/imports/${importEs}`).set(b)).status).toBe(404);
    expect((await http().delete(`/seo-advanced/imports/${importEs}`).set(b)).status).toBe(404);
  });

  it('panel: periodos, comparación con el anterior, importados y otros dominios', async () => {
    const week = await http().get('/seo-advanced/dashboard?period=7d').set(a);
    expect(week.status).toBe(200);
    const w = week.body;
    expect(w).toMatchObject({ lastDate: yesterday(), from: dayAt(-6), to: dayAt(0), days: 7 });
    expect(w.current).toMatchObject({ clicks: 49, impressions: 770 });
    expect(w.previous).toMatchObject({ clicks: 49, impressions: 770 });
    expect(w.previousChange).toMatchObject({ clicksPct: 0, positionDiff: 0 });
    // Sin datos de hace un año, no se compara.
    expect(w.yearAgo).toBeNull();
    expect(w.daily).toHaveLength(7);
    expect(w.daily[0]).toMatchObject({ clicks: 7, source: 'api', previousClicks: 7 });
    expect(w.importedDays).toBe(0);
    expect(w.devices.map((d: { key: string }) => d.key).sort()).toEqual(['DESKTOP', 'MOBILE']);
    expect(w.countries.map((c: { key: string }) => c.key).sort()).toEqual(['esp', 'fra']);
    expect(w.countriesRest).toBeNull();
    expect(w.searchTypes.map((t: { key: string }) => t.key).sort()).toEqual(['image', 'web']);
    expect(w.undetailed).toMatchObject({ clicks: 7, impressions: 105 });
    // El secundario, aparte y sin sumarse.
    expect(w.otherDomains).toEqual([
      expect.objectContaining({ domainId: externalDomain, clicks: 49, impressions: 770 }),
    ]);

    // 28 días: −27 a 0. Del Excel, −24 a −20 (2 clics al día).
    const month = await http().get('/seo-advanced/dashboard?period=28d').set(a);
    expect(month.body.importedDays).toBe(5);
    expect(month.body.current.clicks).toBe(20 * 7 + 5 * 2);
    expect(month.body.previous).toBeNull();
    const first = month.body.daily.find((d: { date: string }) => d.date === dayAt(-24));
    expect(first).toMatchObject({ source: 'import', clicks: 2 });

    // Personalizado: solo los días importados.
    const custom = await http()
      .get(`/seo-advanced/dashboard?period=custom&from=${dayAt(-24)}&to=${dayAt(-20)}`)
      .set(a);
    expect(custom.body).toMatchObject({ days: 5, importedDays: 5 });
    expect(custom.body.current.clicks).toBe(10);
    expect((await http().get('/seo-advanced/dashboard?period=custom').set(a)).status).toBe(400);

    // El dominio secundario se ve aparte.
    const second = await http()
      .get(`/seo-advanced/dashboard?period=7d&domainId=${externalDomain}`)
      .set(a);
    expect(second.body.domain).toBe(`mislata-${tenantA.slug}.es`);
    expect(second.body.otherDomains[0].domainId).toBe(primaryA);
  });

  it('búsquedas y páginas: variación, búsqueda, páginas, CSV y cruce', async () => {
    const q = await http().get('/seo-advanced/queries?period=7d').set(a);
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ dimension: 'query', total: 3, previousAvailable: true });
    expect(q.body.items[0]).toMatchObject({
      key: 'trasteros mislata',
      clicks: 21,
      impressions: 210,
      previousClicks: 21,
      clicksChange: 0,
      positionDiff: 0,
    });

    // Sin periodo anterior completo, no hay variación.
    const month = await http().get('/seo-advanced/queries?period=28d').set(a);
    expect(month.body.previousAvailable).toBe(false);
    expect(month.body.items[0].clicksChange).toBeNull();

    const search = await http().get('/seo-advanced/queries?period=7d&search=MISLATA').set(a);
    expect(search.body.items.map((r: { key: string }) => r.key)).toEqual(['trasteros mislata']);

    const p1 = await http().get('/seo-advanced/queries?period=7d&limit=2').set(a);
    expect(p1.body).toMatchObject({ total: 3, hasMore: true });
    const p2 = await http().get('/seo-advanced/queries?period=7d&limit=2&offset=2').set(a);
    expect(p2.body).toMatchObject({ hasMore: false });
    expect(p2.body.items).toHaveLength(1);

    // Ordenadas por posición: arriba la mejor.
    const byPos = await http().get('/seo-advanced/queries?period=7d&sort=position').set(a);
    const positions = byPos.body.items.map((r: { position: number }) => r.position);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);

    const pages = await http().get('/seo-advanced/pages?period=7d').set(a);
    expect(pages.body.total).toBe(3);

    const csv = await http().get('/seo-advanced/queries/csv?period=7d').set(a);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.replace(String.fromCharCode(0xfeff), '').split('\r\n');
    expect(lines[0]).toBe(
      'Búsqueda;Clics;Impresiones;CTR (%);Posición media;Clics periodo anterior;Variación de clics;Posición periodo anterior;Puestos que sube',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('trasteros mislata;21;210;10;');

    const cross = await http()
      .get('/seo-advanced/cross?period=7d&dimension=query&value=trasteros%20mislata')
      .set(a);
    expect(cross.body.rows).toEqual([
      expect.objectContaining({
        key: `https://tienda.${tenantA.slug}.es/trasteros-en-mislata`,
        clicks: 21,
      }),
    ]);
    const back = await http()
      .get(
        `/seo-advanced/cross?period=7d&dimension=page&value=${encodeURIComponent(`https://tienda.${tenantA.slug}.es/`)}`,
      )
      .set(a);
    expect(back.body.rows.map((r: { key: string }) => r.key)).toEqual(['trasteros cerca de mi']);
  });

  it('interanual, vista global del admin y soporte en solo lectura', async () => {
    // Un año antes de la última semana de la plataforma: 3 clics y 50 impresiones al día.
    const from = seoShiftYears(dayAt(-6), -1);
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: Array.from({ length: 7 }, (_, i) => ({
          domainId: platformDomain,
          grain: 'site',
          date: new Date(`${shiftDate(from, i)}T00:00:00Z`),
          clicks: 3,
          impressions: 50,
          ctr: 0.06,
          position: 9,
        })),
      }),
    );
    const dash = await http()
      .get(`/admin/seo/projects/${platformProject}/dashboard?period=7d`)
      .set(asSupport());
    expect(dash.status).toBe(200);
    expect(dash.body.yearAgo).toMatchObject({ clicks: 21, impressions: 350 });
    expect(dash.body.yearAgoChange.clicksPct).toBe(133.3);

    // Vista global: la plataforma y los tenants, con sus 28 días.
    const overview = await http().get('/admin/seo/overview').set(asSupport());
    expect(overview.status).toBe(200);
    const platformRow = overview.body.find(
      (p: { projectId: string }) => p.projectId === platformProject,
    );
    expect(platformRow).toMatchObject({ tenantId: null, domain: 'e2e-panel.es' });
    expect(platformRow.current.clicks).toBe(140);
    const tenantRow = overview.body.find((p: { projectId: string }) => p.projectId === projectA);
    expect(tenantRow).toMatchObject({
      tenantId: tenantA.tenantId,
      domain: `tienda.${tenantA.slug}.es`,
    });
    expect(tenantRow.current.clicks).toBe(150);

    // El admin lee el panel y las importaciones del tenant...
    expect(
      (await http().get(`/admin/seo/projects/${projectA}/queries?period=7d`).set(asSupport())).body
        .total,
    ).toBe(3);
    const imports = await http().get(`/admin/seo/projects/${projectA}/imports`).set(asSupport());
    expect(imports.body.length).toBe(2);
    // ...pero no importa en él, y el soporte no importa en ninguno.
    const file = await xlsx({
      Dates: [
        ['Date', 'Clicks', 'Impressions', 'CTR', 'Position'],
        [dayAt(-200), 1, 10, '10%', '3'],
      ],
    });
    const attach = (path: string, headers: Record<string, string>, domainId: string) =>
      http()
        .post(path)
        .set(headers)
        .field('domainId', domainId)
        .attach('file', file, { filename: 'f.xlsx', contentType: XLSX });
    expect(
      (await attach(`/admin/seo/projects/${platformProject}/imports`, asSupport(), platformDomain))
        .status,
    ).toBe(403);
    expect(
      (await attach(`/admin/seo/projects/${projectA}/imports`, asSuper(), primaryA)).status,
    ).toBe(404);
    const ok = await attach(
      `/admin/seo/projects/${platformProject}/imports`,
      asSuper(),
      platformDomain,
    );
    expect(ok.status).toBe(201);
    expect(ok.body.siteDaysAdded).toBe(1);

    // El tenant sin el extra ya no ve su panel.
    await setTenantFeatureOverride(tenantA.slug, 'seo_advanced', false);
    expect((await http().get('/seo-advanced/dashboard').set(a)).status).toBe(403);
  });
});
