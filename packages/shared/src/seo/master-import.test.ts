import { describe, expect, it } from 'vitest';

import { parseGscExport } from './gsc-import';
import {
  SeoMasterImportError,
  masterDueDate,
  masterKeywordNotes,
  masterTaskDescription,
  masterTaskStatus,
  masterTaskTitle,
  masterTaskType,
  mergeMasterGscQueries,
  parseMasterDeadline,
  parseMasterIntent,
  parseMasterNumber,
  parseMasterPriority,
  parseSeoMaster,
  seoMasterOriginLabel,
} from './master-import';

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

const kwRow = (o: Record<string, string>) => KW_HEADER.map((h) => o[h] ?? '');

const summary = {
  name: 'Resumen',
  rows: [
    ['INDICADOR', 'VALOR', 'Interpretación'],
    ['Dominio', 'ejemplo.es', ''],
    ['Fecha extracción', '2026-11-25', ''],
    ['Inicio GSC', '2026-10-04', ''],
    ['Fin GSC', '2026-11-23', ''],
  ],
};

describe('mapeos del maestro', () => {
  it('intención y prioridad', () => {
    expect(parseMasterIntent('Transaccional')).toBe('do');
    expect(parseMasterIntent('Comercial')).toBe('do');
    expect(parseMasterIntent('Informativa')).toBe('know');
    expect(parseMasterIntent('Navegacional')).toBe('website');
    expect(parseMasterIntent('Mixta')).toBeNull();
    expect(parseMasterIntent('Excluir / observar')).toBeNull();
    expect(parseMasterIntent('')).toBeNull();
    expect(parseMasterIntent('Rara')).toBe('invalid');
    expect(parseMasterPriority('Muy alta')).toBe(1);
    expect(parseMasterPriority('Alta')).toBe(1);
    expect(parseMasterPriority('Media')).toBe(2);
    expect(parseMasterPriority('Baja')).toBe(3);
    expect(parseMasterPriority('Urgentísima')).toBe('invalid');
  });

  it('vacío no es cero', () => {
    expect(parseMasterNumber('')).toBeNull();
    expect(parseMasterNumber('0')).toBe(0);
    expect(parseMasterNumber('3,1')).toBe(3.1);
    expect(parseMasterNumber('0.050199999999999995')).toBeCloseTo(0.0502);
    expect(parseMasterNumber('n/d')).toBe('invalid');
  });

  it('plazo → fecha límite desde el día de la importación', () => {
    expect(masterDueDate(parseMasterDeadline('Semana 1'), '2026-11-26')).toBe('2026-12-03');
    expect(masterDueDate(parseMasterDeadline('Semana 4'), '2026-11-26')).toBe('2026-12-24');
    expect(masterDueDate(parseMasterDeadline('Mes 2'), '2026-11-30')).toBe('2027-01-30');
    expect(masterDueDate(parseMasterDeadline('Mes 3'), '2026-11-30')).toBe('2027-02-28');
    expect(parseMasterDeadline('Cuando se pueda')).toBeNull();
    expect(masterDueDate(null, '2026-11-26')).toBeNull();
  });

  it('estado, tipo, título y descripción de las tareas', () => {
    expect(masterTaskStatus('Pendiente')).toBe('todo');
    expect(masterTaskStatus('En curso')).toBe('in_progress');
    expect(masterTaskStatus('Hecha')).toBe('done');
    expect(masterTaskType('SEO local', 'Proximidad')).toBe('local');
    expect(masterTaskType('Captación enlaces', 'Enlaces')).toBe('links');
    expect(masterTaskType('Auditar', 'SEO técnico')).toBe('technical');
    expect(masterTaskType('Optimizar existente', 'Mislata')).toBe('content');
    expect(masterTaskType('Validar o crear', 'Contratos')).toBe('content');
    expect(masterTaskType('Otra cosa', 'X')).toBe('other');
    expect(
      masterTaskTitle({ title: '—', action: 'Revisar existente', path: '/mislata', ref: 'P02' }),
    ).toBe('Revisar existente: /mislata');
    expect(
      masterTaskTitle({ title: 'Trasteros en Mislata', action: 'x', path: '/', ref: 'P01' }),
    ).toBe('Trasteros en Mislata');
    const description = masterTaskDescription({
      line: 2,
      ref: 'P01',
      deadline: null,
      deadlineLabel: 'Semana 1',
      cluster: 'Mislata',
      path: '/trasteros-en-mislata',
      action: 'Optimizar existente',
      title: 'Trasteros en Mislata | GUÁRDALO',
      detail: 'Revisar H1 y precios.',
      kpi: 'Reservas',
      status: 'todo',
      statusLabel: 'Pendiente',
      type: 'content',
    });
    expect(description).toContain('Revisar H1 y precios.');
    expect(description).toContain('Título propuesto: Trasteros en Mislata | GUÁRDALO');
    expect(description).toContain('KPI: Reservas');
    expect(description).toContain('Del plan del maestro: P01 · Semana 1');
    expect(
      masterKeywordNotes({ action: 'Optimizar / validar URL', status: 'Pendiente', relevance: 4 }),
    ).toBe('Del maestro: Optimizar / validar URL · Pendiente · relevancia 4/4');
    expect(seoMasterOriginLabel('2026-11-25T10:00:00Z')).toBe('Importado del maestro, 25/11/2026');
  });
});

describe('parseSeoMaster', () => {
  const base = () => [
    summary,
    {
      name: 'Maestro_keywords',
      rows: [
        KW_HEADER,
        kwRow({
          keyword_id: 'ejemplo.es|Trasteros Mislata',
          keyword: 'trasteros mislata',
          cluster: 'Mislata',
          intencion_propuesta: 'Transaccional',
          prioridad: 'Muy alta',
          url_objetivo_propuesta: 'https://ejemplo.es/trasteros-en-mislata',
          gsc_clics: '1',
          gsc_impresiones: '114',
          gsc_ctr: '0.0088',
          gsc_posicion_media: '46.53',
          sistrix_volumen_mes: '20',
          sistrix_competencia: '',
          sistrix_cpc_eur: '0',
          sistrix_clics_mes: '10',
          estado: 'Pendiente',
          fecha_consulta: '2026-11-25',
          gsc_inicio: '2026-10-04',
          gsc_fin: '2026-11-23',
          sistrix_pais: 'ES',
          accion_propuesta: 'Optimizar / validar URL',
          peso_relevancia: '4',
        }),
        kwRow({
          keyword_id: 'ejemplo.es|trasteros baratos',
          keyword: 'trasteros baratos',
          gsc_clics: '0',
          gsc_impresiones: '0',
          gsc_ctr: '6',
          gsc_posicion_media: '6',
          estado: 'Descartar',
          intencion_propuesta: 'Excluir / observar',
          prioridad: 'Baja',
        }),
        kwRow({ keyword_id: 'otro.es|trasteros', keyword: 'trasteros' }),
        kwRow({ keyword_id: 'ejemplo.es|trasteros mislata', keyword: 'trasteros mislata' }),
        kwRow({ keyword_id: '', keyword: '' }),
        kwRow({
          keyword_id: 'ejemplo.es|guardamuebles',
          keyword: 'guardamuebles',
          sistrix_volumen_mes: 'mucho',
        }),
      ],
    },
    {
      name: 'Rankings_competencia',
      rows: [
        ['dominio', 'keyword', 'posicion', 'url', 'pais', 'fecha_consulta', 'fuente'],
        ['rival.es', 'trasteros mislata', '3', 'https://rival.es/', 'ES', '2026-11-25', 'SISTRIX'],
        [
          'rival.es',
          'trasteros mislata',
          '7',
          'https://rival.es/otra',
          'ES',
          '2026-11-25',
          'SISTRIX',
        ],
        ['rival.es', 'guardamuebles', 'diez', '', 'ES', '2026-11-25', ''],
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
        ['rival.es', 'Datos obtenidos', '2', '2', '1', 'Landings por barrio', 'https://rival.es'],
        ['https://www.rival.es', 'Datos obtenidos', '', '', '', '', ''],
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
          'Mislata',
          '9',
          '300',
          '2',
          '8',
          'Muy alta',
          'https://ejemplo.es/trasteros-en-mislata',
          'No sumar variantes.',
        ],
        ['No objetivo', '42', '17', '0', '0', 'Baja', '', ''],
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
        [
          'P01',
          'Semana 1',
          'Mislata',
          '/trasteros-en-mislata',
          'Optimizar existente',
          'Trasteros en Mislata',
          'Revisar H1.',
          'Reservas',
          'Pendiente',
        ],
        [
          'P02',
          'Pronto',
          'SEO técnico',
          '/',
          'Auditar',
          '—',
          'Canonicals.',
          'Cobertura',
          'Pendiente',
        ],
        ['p01', 'Semana 2', '', '', '', '', '', '', ''],
      ],
    },
    {
      name: 'GSC_diario',
      rows: [
        ['Fecha', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['2026-10-04', '0', '0', '6', '6'],
        ['2026-10-05', '1', '10', '0.1', '5'],
      ],
    },
    {
      name: 'GSC_consultas',
      rows: [
        ['Consultas principales', 'Clics', 'Impresiones', 'CTR', 'Posición'],
        ['trasteros mislata', '1', '114', '0.0088', '46.53'],
      ],
    },
    {
      name: 'GSC_filtros',
      rows: [
        ['Filtrar', 'Valor'],
        ['Tipo de búsqueda', 'Web (basada en texto)'],
      ],
    },
    {
      name: 'Fuentes_importacion',
      rows: [
        ['Campo / asunto', 'Regla / interpretación', 'Fuente / referencia'],
        ['Valores nulos', 'Celdas vacías = no consultado.', 'Maestro_keywords'],
      ],
    },
  ];

  it('lee cada hoja con sus reglas', () => {
    const m = parseSeoMaster(base());
    expect(m).toMatchObject({
      domain: 'ejemplo.es',
      extractedAt: '2026-11-25',
      gscFrom: '2026-10-04',
      gscTo: '2026-11-23',
    });
    expect(m.rules).toEqual([
      {
        field: 'Valores nulos',
        rule: 'Celdas vacías = no consultado.',
        source: 'Maestro_keywords',
      },
    ]);
    // keyword_id en minúsculas, con tildes, y sin repetir.
    expect(m.keywords.map((k) => k.key)).toEqual([
      'ejemplo.es|trasteros mislata',
      'ejemplo.es|trasteros baratos',
      'ejemplo.es|guardamuebles',
    ]);
    const first = m.keywords[0]!;
    expect(first).toMatchObject({
      intent: 'do',
      priority: 1,
      group: 'Mislata',
      relevance: 4,
      discard: false,
    });
    // Vacío ≠ 0: la competencia vacía es null y el CPC 0 es 0.
    expect(first.sistrix).toEqual({ traffic: 20, competition: null, cpc: 0, clicks: 10 });
    // Sin impresiones, el CTR y la posición se ignoran.
    expect(m.keywords[1]!.gsc).toEqual({ clicks: 0, impressions: 0, ctr: null, position: null });
    expect(m.keywords[1]!.sistrix).toBeNull();
    expect(m.keywords[1]!.discard).toBe(true);
    expect(m.keywords[2]!.sistrix).toBeNull();
    const rejected = m.issues.filter((i) => i.level === 'rejected');
    expect(rejected.map((i) => [i.sheet, i.line])).toEqual(
      expect.arrayContaining([
        ['keywords', 4],
        ['keywords', 5],
        ['rankings', 3],
        ['rankings', 4],
        ['competitors', 3],
        ['plan', 4],
      ]),
    );
    // Las filas vacías se saltan sin más; un número que no lo es se avisa y la fila entra.
    expect(m.issues.find((i) => i.sheet === 'keywords' && i.line === 6)?.level).toBe('warning');
    expect(m.rankings).toEqual([
      expect.objectContaining({
        domain: 'rival.es',
        position: 3,
        country: 'es',
        date: '2026-11-25',
      }),
    ]);
    expect(m.competitors.map((c) => c.domain)).toEqual(['rival.es']);
    expect(m.clusters.map((c) => [c.name, c.priority, c.targetUrl])).toEqual([
      ['Mislata', 1, 'https://ejemplo.es/trasteros-en-mislata'],
      ['No objetivo', 3, null],
    ]);
    expect(m.plan.map((p) => [p.ref, p.type, p.deadline?.days ?? null])).toEqual([
      ['P01', 'content', 7],
      ['P02', 'technical', null],
    ]);
    expect(m.gscSheets.map((s) => s.name)).toEqual(['Fechas', 'Consultas', 'Filtros']);
  });

  it('las pestañas GSC_* se leen como una exportación de Search Console', () => {
    const m = parseSeoMaster(base());
    const gsc = parseGscExport(m.gscSheets);
    expect(gsc.filtered).toBe(false);
    expect(gsc.tabs.find((t) => t.dimension === 'date')!.rows[0]).toEqual({
      value: '2026-10-04',
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
    });
    // «trasteros baratos» tiene datos de Search Console del mismo periodo y no está en GSC_consultas.
    m.keywords[1]!.gscFrom = '2026-10-04';
    m.keywords[1]!.gscTo = '2026-10-05';
    expect(mergeMasterGscQueries(gsc, m.keywords)).toBe(1);
    expect(gsc.tabs.find((t) => t.dimension === 'query')!.rows.map((r) => r.value)).toEqual([
      'trasteros mislata',
      'trasteros baratos',
    ]);
  });

  it('sin Resumen o sin dominio no es un maestro', () => {
    expect(() => parseSeoMaster([{ name: 'Hoja', rows: [['a']] }])).toThrow(SeoMasterImportError);
    expect(() =>
      parseSeoMaster([
        {
          name: 'Resumen',
          rows: [
            ['INDICADOR', 'VALOR'],
            ['Otra', 'x'],
          ],
        },
      ]),
    ).toThrow(/dominio/);
  });
});
