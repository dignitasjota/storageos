import { hash as argonHash } from '@node-rs/argon2';
import { madridToday, shiftDate } from '@storageos/shared';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { buildOpenXmlWorkbook, type OpenXmlCell } from './helpers/openxml-workbook';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-master-super@storageos.local';
const SUPPORT_EMAIL = 'seo-master-support@storageos.local';
const PREFIX = 'E2E maestro ';
const DOMAIN = 'e2e-maestro-seo.es';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** Periodo de Search Console del maestro: 4 días; los 2 primeros ya los tiene la API. */
const GSC = ['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04'];

const KW_HEADER = [
  'keyword_id',
  'keyword',
  'cluster',
  'intencion_propuesta',
  'prioridad',
  'url_objetivo_propuesta',
  'gsc_clics',
  'gsc_impresiones',
  'gsc_ctr',
  'gsc_posicion_media',
  'sistrix_volumen_mes',
  'sistrix_competencia',
  'sistrix_cpc_eur',
  'sistrix_clics_mes',
  'competidores_muestra',
  'mejor_competidor',
  'mejor_posicion_muestra',
  'url_competidor',
  'sistrix_posicion_propia',
  'estado',
  'fuente',
  'fecha_consulta',
  'gsc_inicio',
  'gsc_fin',
  'sistrix_pais',
  'accion_propuesta',
  'peso_relevancia',
];

type Kw = Partial<Record<(typeof KW_HEADER)[number], OpenXmlCell>>;

interface MasterOptions {
  domain: string;
  /** Fecha de consulta de SISTRIX (las observaciones). */
  consulted?: string;
  /** Texto del Resumen (cambia la huella del fichero). */
  note?: string;
  keywords?: Kw[];
  rankings?: OpenXmlCell[][];
  competitors?: OpenXmlCell[][];
  plan?: OpenXmlCell[][];
}

function masterFile(o: MasterOptions): Promise<Buffer> {
  const consulted = o.consulted ?? '2025-03-05';
  const kw = (k: Kw) =>
    KW_HEADER.map((h) => {
      const v = k[h];
      if (v !== undefined) return v;
      if (h === 'fecha_consulta') return consulted;
      return null;
    });
  const keywords: Kw[] = o.keywords ?? [
    {
      keyword_id: `${o.domain}|Trasteros Prueba`,
      keyword: 'trasteros prueba',
      cluster: 'Centro',
      intencion_propuesta: 'Transaccional',
      prioridad: 'Muy alta',
      url_objetivo_propuesta: `https://${o.domain}/trasteros-prueba`,
      gsc_clics: 3,
      gsc_impresiones: 120,
      gsc_ctr: 0.025,
      gsc_posicion_media: 7.5,
      sistrix_volumen_mes: 30,
      sistrix_competencia: null,
      sistrix_cpc_eur: 0,
      sistrix_clics_mes: 20,
      estado: 'Pendiente',
      gsc_inicio: GSC[0]!,
      gsc_fin: GSC[3]!,
      sistrix_pais: 'ES',
      accion_propuesta: 'Optimizar / validar URL',
      peso_relevancia: 4,
    },
    {
      keyword_id: `${o.domain}|trasteros baratos prueba`,
      keyword: 'trasteros baratos prueba',
      cluster: 'No objetivo',
      intencion_propuesta: 'Excluir / observar',
      prioridad: 'Baja',
      gsc_clics: 0,
      gsc_impresiones: 0,
      gsc_ctr: 6,
      gsc_posicion_media: 6,
      estado: 'Descartar',
      gsc_inicio: GSC[0]!,
      gsc_fin: GSC[3]!,
      accion_propuesta: 'No crear página',
      peso_relevancia: 0,
    },
    {
      keyword_id: `${o.domain}|guardamuebles prueba`,
      keyword: 'guardamuebles prueba',
      cluster: 'Centro',
      intencion_propuesta: 'Comercial',
      prioridad: 'Alta',
      sistrix_volumen_mes: 0,
      sistrix_competencia: 0,
      sistrix_cpc_eur: 0,
      sistrix_clics_mes: 0,
      sistrix_posicion_propia: 12,
      estado: 'Pendiente',
      sistrix_pais: 'ES',
      accion_propuesta: 'Optimizar / validar URL',
      peso_relevancia: 3,
    },
    {
      keyword_id: `${o.domain}|palabra fijada`,
      keyword: 'palabra fijada',
      cluster: 'Otro grupo',
      intencion_propuesta: 'Informativa',
      prioridad: 'Media',
    },
    {
      keyword_id: `${o.domain}|palabra a medias`,
      keyword: 'palabra a medias',
      cluster: 'Centro',
      intencion_propuesta: 'Informativa',
      prioridad: 'Media',
      url_objetivo_propuesta: `https://${o.domain}/blog/guia`,
    },
    { keyword_id: 'otro-dominio.es|trasteros', keyword: 'trasteros' },
  ];
  return buildOpenXmlWorkbook([
    {
      name: 'Resumen',
      rows: [
        ['INDICADOR', 'VALOR', 'Interpretación / periodo'],
        ['Dominio', o.domain, 'Google Search Console + SISTRIX'],
        ['Fecha extracción', consulted, o.note ?? 'SISTRIX Google España'],
        ['Inicio GSC', GSC[0]!, 'Exportación tipo Web'],
        ['Fin GSC', GSC[3]!, 'Último día disponible'],
        ['Clics GSC', 7, 'Total diario'],
      ],
    },
    { name: 'Maestro_keywords', rows: [KW_HEADER, ...keywords.map(kw)] },
    {
      name: 'Rankings_competencia',
      rows: [
        ['dominio', 'keyword', 'posicion', 'url', 'pais', 'fecha_consulta', 'fuente'],
        ...(o.rankings ?? [
          [
            'rival-uno.es',
            'trasteros prueba',
            3,
            'https://rival-uno.es/',
            'ES',
            consulted,
            'SISTRIX',
          ],
          [
            'rival-uno.es',
            'trasteros prueba',
            8,
            'https://rival-uno.es/otra',
            'ES',
            consulted,
            'SISTRIX',
          ],
          [
            'rival-dos.es',
            'guardamuebles prueba',
            5,
            'https://rival-dos.es/g',
            'ES',
            consulted,
            'SISTRIX',
          ],
        ]),
      ],
    },
    {
      name: 'Competidores',
      rows: [
        [
          'dominio',
          'estado_consulta',
          'filas_muestra',
          'keywords_unicas',
          'keywords_top10',
          'estrategia_observada',
          'fuente',
        ],
        ...(o.competitors ?? [
          [
            'rival-uno.es',
            'Datos obtenidos',
            2,
            1,
            1,
            'Landings por barrio',
            'https://rival-uno.es',
          ],
          [
            'rival-dos.es',
            'Sin resultados SISTRIX',
            0,
            0,
            0,
            'Por investigar',
            'https://rival-dos.es',
          ],
          [o.domain, 'Datos obtenidos', 0, 0, 0, '', ''],
        ]),
      ],
    },
    {
      name: 'Clusters',
      rows: [
        [
          'cluster',
          'keywords',
          'impresiones_gsc_exportadas',
          'clics_gsc_exportados',
          'keywords_con_metricas',
          'prioridad_propuesta',
          'url_objetivo_principal',
          'nota',
        ],
        [
          'Centro',
          3,
          120,
          3,
          2,
          'Muy alta',
          `https://${o.domain}/trasteros-prueba`,
          'No sumar variantes.',
        ],
        ['No objetivo', 1, 0, 0, 0, 'Baja', null, null],
      ],
    },
    {
      name: 'Plan_accion',
      rows: [
        [
          'id',
          'plazo',
          'cluster',
          'ruta_propuesta',
          'accion',
          'title_propuesto',
          'detalle',
          'kpi',
          'estado',
        ],
        ...(o.plan ?? [
          [
            'P01',
            'Semana 1',
            'Centro',
            '/trasteros-prueba',
            'Optimizar existente',
            'Trasteros de prueba | E2E',
            'Revisar H1 y precios.',
            'Reservas',
            'Pendiente',
          ],
          [
            'P02',
            'Mes 2',
            'SEO técnico',
            '/',
            'Auditar',
            '—',
            'Revisar canonicals.',
            'Cobertura',
            'Pendiente',
          ],
        ]),
      ],
    },
    {
      name: 'GSC_consultas',
      rows: [
        ['Consultas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['trasteros prueba', 3, 120, 0.025, 7.5],
      ],
    },
    {
      name: 'GSC_paginas',
      rows: [
        ['Páginas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        [`https://${o.domain}/`, 3, 130, 0.023, 9.1],
      ],
    },
    {
      name: 'GSC_diario',
      rows: [
        ['Fecha', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        [GSC[0]!, 9, 90, 0.1, 4],
        [GSC[1]!, 9, 90, 0.1, 4],
        [GSC[2]!, 0, 0, '6', '6'],
        [GSC[3]!, 2, 40, 0.05, 8.25],
      ],
    },
    {
      name: 'GSC_dispositivos',
      rows: [
        ['Dispositivo', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['Móviles', 2, 100, 0.02, 7],
      ],
    },
    {
      name: 'GSC_aparicion',
      rows: [['Aparición en búsquedas', 'Clics', 'Impresiones', 'CTR', 'Posición']],
    },
    {
      name: 'GSC_filtros',
      rows: [
        ['Filtrar', 'Valor'],
        ['Tipo de búsqueda', 'Web (basada en texto)'],
        ['Fecha', 'Últimos 16 meses'],
      ],
    },
    {
      name: 'Fuentes_importacion',
      rows: [
        ['Campo / asunto', 'Regla / interpretación', 'Fuente / referencia'],
        [
          'Valores nulos',
          'Celdas vacías = no consultado; ceros = valor devuelto.',
          'Maestro_keywords',
        ],
      ],
    },
  ]);
}

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

type Sheet = {
  sheet: string;
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  reasons: { reason: string; count: number }[];
};
const sheetOf = (body: { sheets: Sheet[] }, sheet: string) =>
  body.sheets.find((s) => s.sheet === sheet)!;

describe('SEO Avanzado: importación de los Excel maestros (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  let projectId = '';
  let domainId = '';
  let firstImport = '';
  const tenantIds: string[] = [];
  const base = () => `/admin/seo/projects/${projectId}`;

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoDomainKeyword.deleteMany({
        where: {
          tenantId: null,
          provider: 'manual_import',
          domain: { in: [DOMAIN, 'rival-uno.es', 'rival-dos.es'] },
        },
      });
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  const upload = (path: string, file: Buffer, token: { Authorization: string }) =>
    http()
      .post(path)
      .set(token)
      .attach('file', file, { filename: 'SEO_maestro_E2E.xlsx', contentType: XLSX });

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      await db.superAdmin.create({
        data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Maestro', role: 'superadmin' },
      });
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Maestro', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'local' });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    domainId = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: { projectId, domain: DOMAIN, role: 'primary', gscProperty: `sc-domain:${DOMAIN}` },
        }),
      )
    ).id;
    // Lo que ya hay: dos días de la API, una palabra fijada a mano y otra a medias.
    await withAdminDb(async (db) => {
      await db.seoGscMetric.createMany({
        data: GSC.slice(0, 2).map((d) => ({
          tenantId: null,
          domainId,
          grain: 'site',
          date: asDate(d),
          clicks: 50,
          impressions: 500,
          ctr: 0.1,
          position: 3,
          source: 'api',
        })),
      });
      for (const [word, data] of [
        ['palabra fijada', { strategyLocked: true, groupName: null, intent: null }],
        ['palabra a medias', { strategyLocked: false, groupName: 'Mi grupo', intent: null }],
      ] as const) {
        const k = await db.seoKeyword.upsert({
          where: { keyword_country_language: { keyword: word, country: 'ES', language: 'es' } },
          create: { keyword: word, country: 'ES', language: 'es' },
          update: {},
        });
        await db.seoProjectKeyword.create({
          data: { tenantId: null, projectId, keywordId: k.id, source: 'manual', ...data },
        });
      }
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('vista previa por hojas, sin guardar nada', async () => {
    const file = await masterFile({ domain: DOMAIN });
    const res = await upload(`${base()}/master-imports/preview`, file, asSuper());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: DOMAIN,
      domainId,
      extractedAt: '2025-03-05',
      gscFrom: GSC[0],
      gscTo: GSC[3],
      importDate: madridToday(),
    });
    expect(res.body.rules).toEqual([expect.objectContaining({ field: 'Valores nulos' })]);
    const kw = sheetOf(res.body, 'keywords');
    expect(kw).toMatchObject({ rows: 6, created: 3, updated: 1, skipped: 2 });
    expect(kw.reasons.map((r) => r.reason)).toEqual(
      expect.arrayContaining([
        'Fijada a mano: el maestro no la toca.',
        expect.stringContaining(`no es de ${DOMAIN}`),
      ]),
    );
    expect(sheetOf(res.body, 'rankings')).toMatchObject({ rows: 3, created: 2, skipped: 1 });
    expect(sheetOf(res.body, 'competitors')).toMatchObject({ created: 2, skipped: 1 });
    expect(sheetOf(res.body, 'clusters')).toMatchObject({ created: 2 });
    expect(sheetOf(res.body, 'plan')).toMatchObject({ created: 2 });
    expect(res.body.gsc).toMatchObject({ siteDaysToAdd: 2, siteDaysApi: 2, filtered: false });
    expect(res.body.issuesTotal).toBeGreaterThanOrEqual(2);
    const stored = await withAdminDb((db) => db.seoMasterImport.count({ where: { projectId } }));
    expect(stored).toBe(0);
  });

  it('importa cada hoja a su sitio sin pisar lo manual ni el histórico', async () => {
    const file = await masterFile({ domain: DOMAIN });
    const res = await upload(`${base()}/master-imports`, file, asSuper());
    expect(res.status).toBe(201);
    firstImport = res.body.id;
    expect(res.body.gscImportId).toEqual(expect.any(String));

    // Catálogo: nuevas con su origen; la descartada, sin seguir; la fijada, intacta; la otra, rellenada.
    const keywords = await http().get(`${base()}/keywords`).set(asSuper());
    expect(keywords.status).toBe(200);
    const byWord = new Map<string, Record<string, unknown>>(
      keywords.body.map((k: { keyword: string }) => [k.keyword, k]),
    );
    expect(byWord.get('trasteros prueba')).toMatchObject({
      source: 'master',
      groupName: 'Centro',
      intent: 'do',
      priority: 1,
      targetUrl: `https://${DOMAIN}/trasteros-prueba`,
      notes: 'Del maestro: Optimizar / validar URL · Pendiente · relevancia 4/4',
      isActive: true,
      masterImportedAt: expect.any(String),
    });
    expect(byWord.get('trasteros baratos prueba')).toMatchObject({ isActive: false, intent: null });
    expect(byWord.get('palabra fijada')).toMatchObject({
      source: 'manual',
      groupName: null,
      intent: null,
      masterImportedAt: null,
    });
    expect(byWord.get('palabra a medias')).toMatchObject({
      groupName: 'Mi grupo',
      intent: 'know',
      targetUrl: `https://${DOMAIN}/blog/guia`,
    });
    expect(byWord.has('trasteros')).toBe(false);
    // Métricas de SISTRIX como observación: vacío ≠ 0.
    expect(byWord.get('trasteros prueba')!.metrics).toMatchObject({
      provider: 'manual_import',
      traffic: 30,
      competition: null,
      cpc: 0,
      clicks: 20,
      dataDate: '2025-03-05',
    });
    expect(byWord.get('guardamuebles prueba')!.metrics).toMatchObject({
      traffic: 0,
      competition: 0,
    });

    // Posiciones: la mejor de la repetida y la propia de SISTRIX.
    const ranks = await withAdminDb((db) =>
      db.seoDomainKeyword.findMany({
        where: { masterImportId: firstImport },
        orderBy: [{ domain: 'asc' }, { keyword: 'asc' }],
      }),
    );
    expect(ranks.map((r) => [r.domain, r.keyword, r.position])).toEqual([
      [DOMAIN, 'guardamuebles prueba', 12],
      ['rival-dos.es', 'guardamuebles prueba', 5],
      ['rival-uno.es', 'trasteros prueba', 3],
    ]);

    // Competidores (el propio no), grupos y tareas.
    const comps = await withAdminDb((db) =>
      db.seoCompetitor.findMany({ where: { projectId }, orderBy: { domain: 'asc' } }),
    );
    expect(comps.map((c) => [c.domain, c.isActive, c.source, c.notes])).toEqual([
      ['rival-dos.es', true, 'master', 'Del maestro: Por investigar (Sin resultados SISTRIX)'],
      ['rival-uno.es', true, 'master', 'Del maestro: Landings por barrio'],
    ]);
    const groups = await http().get(`${base()}/keyword-groups`).set(asSupport());
    expect(groups.status).toBe(200);
    expect(groups.body).toEqual([
      expect.objectContaining({ name: 'Centro', priority: 1, source: 'master', keywords: 2 }),
      expect.objectContaining({ name: 'No objetivo', priority: 3, targetUrl: null }),
    ]);
    const tasks = await http().get(`${base()}/plan/tasks`).set(asSuper());
    expect(tasks.status).toBe(200);
    const p01 = tasks.body.items.find(
      (t: { title: string }) => t.title === 'Trasteros de prueba | E2E',
    );
    expect(p01).toMatchObject({
      type: 'content',
      status: 'todo',
      priority: 'high',
      dueDate: shiftDate(madridToday(), 7),
      url: `https://${DOMAIN}/trasteros-prueba`,
      sourceLabel: expect.stringMatching(/^Importado del maestro, \d\d\/\d\d\/\d{4} \(P01\)$/),
    });
    expect(p01.description).toContain('KPI: Reservas');
    const p02 = tasks.body.items.find((t: { title: string }) => t.title === 'Auditar: /');
    expect(p02).toMatchObject({ type: 'technical', priority: 'medium' });

    // Search Console: los días de la API intactos; los demás, de la importación.
    const days = await withAdminDb((db) =>
      db.seoGscMetric.findMany({
        where: { domainId, grain: 'site', date: { gte: asDate(GSC[0]!), lte: asDate(GSC[3]!) } },
        orderBy: { date: 'asc' },
      }),
    );
    expect(days.map((d) => [d.source, d.clicks, Number(d.position)])).toEqual([
      ['api', 50, 3],
      ['api', 50, 3],
      ['import', 0, 0],
      ['import', 2, 8.25],
    ]);
    // Las pestañas del maestro no se borran por la importación de Search Console.
    const gscDel = await http().delete(`${base()}/imports/${res.body.gscImportId}`).set(asSuper());
    expect(gscDel.status).toBe(409);
    expect(gscDel.body.code).toBe('seo_import_from_master');

    // La ficha: Resumen, reglas y qué hizo cada hoja.
    const detail = await http().get(`${base()}/master-imports/${firstImport}`).set(asSupport());
    expect(detail.status).toBe(200);
    expect(detail.body.summary[0]).toMatchObject({ indicator: 'Dominio', value: DOMAIN });
    expect(detail.body.rules).toHaveLength(1);
    expect(detail.body.issues.length).toBeGreaterThan(0);
  });

  it('el mismo fichero dos veces y un maestro de otro dominio no se importan', async () => {
    const same = await upload(
      `${base()}/master-imports`,
      await masterFile({ domain: DOMAIN }),
      asSuper(),
    );
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('seo_master_duplicate');
    const other = await upload(
      `${base()}/master-imports/preview`,
      await masterFile({ domain: 'otro-dominio.es' }),
      asSuper(),
    );
    expect(other.status).toBe(400);
    expect(other.body.code).toBe('seo_master_domain_mismatch');
    expect(other.body.message).toContain('otro-dominio.es');
  });

  it('una versión nueva no pisa lo editado a mano, no duplica tareas y conserva el histórico', async () => {
    // Cambios a mano tras la primera importación.
    await withAdminDb(async (db) => {
      await db.seoProjectKeyword.updateMany({
        where: { projectId, keyword: { keyword: 'trasteros prueba' } },
        data: { groupName: 'Mi grupo editado' },
      });
      await db.seoTask.updateMany({
        where: { projectId, externalRef: 'P01' },
        data: { title: 'P01 editada a mano' },
      });
    });
    const v2 = await masterFile({
      domain: DOMAIN,
      consulted: '2025-03-12',
      note: 'Segunda versión',
      rankings: [
        [
          'rival-uno.es',
          'trasteros prueba',
          2,
          'https://rival-uno.es/',
          'ES',
          '2025-03-12',
          'SISTRIX',
        ],
      ],
      plan: [
        [
          'P01',
          'Semana 1',
          'Centro',
          '/trasteros-prueba',
          'Optimizar existente',
          'Otro título',
          'Otro detalle.',
          'Reservas',
          'Pendiente',
        ],
        [
          'P03',
          'Semana 2',
          'Centro',
          '/precios',
          'SEO local',
          '—',
          'Ficha de Google.',
          'Llamadas',
          'Pendiente',
        ],
      ],
    });
    const preview = await upload(`${base()}/master-imports/preview`, v2, asSuper());
    expect(preview.status).toBe(200);
    expect(sheetOf(preview.body, 'plan')).toMatchObject({ created: 1, skipped: 1 });
    const res = await upload(`${base()}/master-imports`, v2, asSuper());
    expect(res.status).toBe(201);

    const kw = await withAdminDb((db) =>
      db.seoProjectKeyword.findFirst({
        where: { projectId, keyword: { keyword: 'trasteros prueba' } },
      }),
    );
    expect(kw!.groupName).toBe('Mi grupo editado');
    const tasks = await withAdminDb((db) =>
      db.seoTask.findMany({ where: { projectId }, orderBy: { externalRef: 'asc' } }),
    );
    expect(tasks.map((t) => [t.externalRef, t.title])).toEqual([
      ['P01', 'P01 editada a mano'],
      ['P02', 'Auditar: /'],
      ['P03', 'SEO local: /precios'],
    ]);
    // Histórico: la posición de antes y la nueva, como dos observaciones.
    const history = await withAdminDb((db) =>
      db.seoDomainKeyword.findMany({
        where: {
          tenantId: null,
          domain: 'rival-uno.es',
          keyword: 'trasteros prueba',
          provider: 'manual_import',
        },
        orderBy: { sampleDate: 'asc' },
      }),
    );
    expect(history.map((h) => h.position)).toEqual([3, 2]);
    const metrics = await withAdminDb((db) =>
      db.seoKeywordMetric.count({
        where: {
          tenantId: null,
          provider: 'manual_import',
          keyword: { keyword: 'trasteros prueba' },
        },
      }),
    );
    expect(metrics).toBe(2);
  });

  it('borrar la importación quita lo que añadió y nadie tocó', async () => {
    const res = await http().delete(`${base()}/master-imports/${firstImport}`).set(asSuper());
    expect(res.status).toBe(200);
    expect(res.body.kept).toBeGreaterThanOrEqual(2);
    expect(res.body.reverted).toBeGreaterThanOrEqual(2);
    const words = await withAdminDb((db) =>
      db.seoProjectKeyword.findMany({
        where: { projectId },
        include: { keyword: { select: { keyword: true } } },
      }),
    );
    const byWord = new Map(words.map((w) => [w.keyword.keyword, w]));
    // La editada a mano se queda; las demás que creó, fuera.
    expect(byWord.get('trasteros prueba')?.groupName).toBe('Mi grupo editado');
    expect(byWord.has('guardamuebles prueba')).toBe(false);
    expect(byWord.has('trasteros baratos prueba')).toBe(false);
    // Lo que rellenó en una que ya estaba vuelve a vacío.
    expect(byWord.get('palabra a medias')).toMatchObject({ groupName: 'Mi grupo', intent: null });
    const tasks = await withAdminDb((db) =>
      db.seoTask.findMany({ where: { projectId }, orderBy: { externalRef: 'asc' } }),
    );
    expect(tasks.map((t) => t.externalRef)).toEqual(['P01', 'P03']);
    // Sus observaciones se van; las de la segunda versión se quedan.
    const left = await withAdminDb((db) =>
      db.seoDomainKeyword.findMany({
        where: { tenantId: null, domain: 'rival-uno.es', provider: 'manual_import' },
      }),
    );
    expect(left.map((h) => h.position)).toEqual([2]);
    const days = await withAdminDb((db) =>
      db.seoGscMetric.findMany({
        where: { domainId, grain: 'site', date: { gte: asDate(GSC[0]!), lte: asDate(GSC[3]!) } },
      }),
    );
    expect(days.map((d) => d.source)).toEqual(['api', 'api']);
    expect(
      (await http().get(`${base()}/master-imports`).set(asSuper())).body.map(
        (i: { id: string }) => i.id,
      ),
    ).not.toContain(firstImport);
  });

  it('soporte solo lee; un tenant importa el suyo con el límite de competidores y aislado', async () => {
    const denied = await upload(
      `${base()}/master-imports/preview`,
      await masterFile({ domain: DOMAIN, note: 'soporte' }),
      asSupport(),
    );
    expect(denied.status).toBe(403);
    expect((await http().get(`${base()}/master-imports`).set(asSupport())).status).toBe(200);

    const owner = await registerVerifiedUser(app, 'seomaestroa');
    const other = await registerVerifiedUser(app, 'seomaestrob');
    tenantIds.push(owner.tenantId, other.tenantId);
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const b = { Authorization: `Bearer ${other.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setTenantFeatureOverride(other.slug, 'seo_advanced', true);
    const domain = `web.${owner.slug}.es`;
    await setVerifiedCustomDomain(owner.slug, domain);
    const project = await http().post('/seo-advanced/project').set(a).send({});
    expect(project.status).toBe(201);
    const tenantProject = project.body.id as string;
    // Ya sigue 9 competidores: del maestro entra 1 activo y el otro como sugerencia.
    await withAdminDb((db) =>
      db.seoCompetitor.createMany({
        data: Array.from({ length: 9 }, (_, i) => ({
          tenantId: owner.tenantId,
          projectId: tenantProject,
          domain: `seguido-${i}.es`,
        })),
      }),
    );
    const res = await upload('/seo-advanced/master-imports', await masterFile({ domain }), a);
    expect(res.status).toBe(201);
    const comps = await withAdminDb((db) =>
      db.seoCompetitor.findMany({
        where: { projectId: tenantProject, source: 'master' },
        orderBy: { domain: 'asc' },
      }),
    );
    expect(comps.map((c) => [c.domain, c.isActive])).toEqual([
      ['rival-dos.es', false],
      ['rival-uno.es', true],
    ]);
    // Las observaciones van al fondo del tenant.
    const ranks = await withAdminDb((db) =>
      db.seoDomainKeyword.count({
        where: { masterImportId: res.body.id, tenantId: owner.tenantId },
      }),
    );
    expect(ranks).toBe(3);

    // Otro tenant no la ve; el admin no importa en un proyecto de tenant.
    expect((await http().get('/seo-advanced/master-imports').set(a)).body).toHaveLength(1);
    expect((await http().get(`/seo-advanced/master-imports/${res.body.id}`).set(b)).status).toBe(
      404,
    );
    const adminInTenant = await upload(
      `/admin/seo/projects/${tenantProject}/master-imports/preview`,
      await masterFile({ domain, note: 'admin' }),
      asSuper(),
    );
    expect(adminInTenant.status).toBe(404);
    expect(
      (await http().get(`/admin/seo/projects/${tenantProject}/master-imports`).set(asSupport()))
        .body,
    ).toHaveLength(1);
  });
});
