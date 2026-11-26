import { describe, expect, it } from 'vitest';

import {
  GscImportError,
  analyzeGscFilters,
  detectGscTab,
  parseGscCtr,
  parseGscDate,
  parseGscDecimal,
  parseGscExport,
  parseGscInt,
} from './gsc-import';

describe('lectura de valores', () => {
  it('números, CTR y fechas en español y en inglés', () => {
    expect(parseGscInt('1234')).toBe(1234);
    expect(parseGscInt('1.234')).toBe(1234);
    expect(parseGscInt('abc')).toBeNull();
    expect(parseGscDecimal('8,5')).toBe(8.5);
    expect(parseGscDecimal('8.5')).toBe(8.5);
    expect(parseGscCtr('3,45 %')).toBe(0.0345);
    expect(parseGscCtr('3.45%')).toBe(0.0345);
    expect(parseGscCtr('0.0345')).toBe(0.0345);
    expect(parseGscDate('2025-03-31')).toBe('2025-03-31');
    expect(parseGscDate('31/03/2025')).toBe('2025-03-31');
    expect(parseGscDate('45747')).toBe('2025-03-31');
    expect(parseGscDate('2025-02-30')).toBeNull();
  });

  it('reconoce las pestañas por nombre o por la primera cabecera', () => {
    expect(detectGscTab('Consultas', [])).toEqual({ tab: 'query', language: 'es' });
    expect(detectGscTab('Queries.csv', [])).toEqual({ tab: 'query', language: 'en' });
    expect(detectGscTab('Hoja1', ['Páginas principales'])).toEqual({
      tab: 'page',
      language: 'es',
    });
    expect(detectGscTab('Aspecto en las búsquedas', [])?.tab).toBe('search_appearance');
    expect(detectGscTab('Otra cosa', ['Columna'])).toBeNull();
  });

  it('un Excel con filtros de país o de tipo de búsqueda no es el total', () => {
    expect(
      analyzeGscFilters([
        { name: 'Tipo de búsqueda', value: 'Web' },
        { name: 'Fecha', value: 'Últimos 3 meses' },
      ]),
    ).toEqual({ filtered: false, reasons: [] });
    const f = analyzeGscFilters([
      { name: 'Search type', value: 'Image' },
      { name: 'Country', value: 'Spain' },
    ]);
    expect(f.filtered).toBe(true);
    expect(f.reasons).toHaveLength(2);
  });
});

const header = ['Clics', 'Impresiones', 'CTR', 'Posición'];

describe('parseGscExport', () => {
  it('lee todas las pestañas y el periodo de la de fechas', () => {
    const parsed = parseGscExport([
      {
        name: 'Consultas',
        rows: [
          ['Consultas principales', ...header],
          ['trasteros mislata', '30', '300', '10 %', '3,2'],
          ['', '1', '1', '1 %', '1'],
        ],
      },
      {
        name: 'Dispositivos',
        rows: [
          ['Dispositivo', ...header],
          ['Móvil', '20', '200', '10%', '4'],
        ],
      },
      {
        name: 'Fechas',
        rows: [
          ['Fecha', ...header],
          ['2025-01-02', '3', '30', '10%', '5'],
          ['2025-01-01', '2', '20', '10%', '6'],
        ],
      },
      {
        name: 'Filtros',
        rows: [
          ['Filtro', 'Valor'],
          ['Tipo de búsqueda', 'Web'],
        ],
      },
    ]);
    expect(parsed.language).toBe('es');
    expect(parsed).toMatchObject({ periodFrom: '2025-01-01', periodTo: '2025-01-02' });
    expect(parsed.filtered).toBe(false);
    expect(parsed.tabs.map((t) => t.dimension)).toEqual(['query', 'device', 'date']);
    expect(parsed.tabs[0]!.rows).toEqual([
      { value: 'trasteros mislata', clicks: 30, impressions: 300, ctr: 0.1, position: 3.2 },
    ]);
    expect(parsed.tabs[1]!.rows[0]!.value).toBe('MOBILE');
    expect(parsed.warnings[0]).toContain('1 fila');
  });

  it('sin la pestaña de fechas, o comparando periodos, no se importa', () => {
    expect(() =>
      parseGscExport([{ name: 'Queries', rows: [['Top queries', 'Clicks', 'Impressions']] }]),
    ).toThrow(GscImportError);
    expect(() =>
      parseGscExport([
        {
          name: 'Dates',
          rows: [
            ['Date', 'Last 28 days Clicks', 'Previous 28 days Clicks', 'Impressions'],
            ['2025-01-01', '1', '2', '3'],
          ],
        },
      ]),
    ).toThrow(/compara dos periodos/);
    expect(() => parseGscExport([{ name: 'Hoja', rows: [['a', 'b']] }])).toThrow(
      /No parece una exportación/,
    );
  });
});

describe('exportaciones del maestro de SEO', () => {
  it('ignora el CTR y la posición de los días sin impresiones', () => {
    const parsed = parseGscExport([
      {
        name: 'Fechas',
        rows: [
          ['Fecha', ...header],
          ['2026-10-04', '0', '0', '6', '6'],
          ['2026-10-06', '0', '2', '0', '50'],
        ],
      },
    ]);
    expect(parsed.tabs[0]!.rows).toEqual([
      { value: '2026-10-04', clicks: 0, impressions: 0, ctr: null, position: null },
      { value: '2026-10-06', clicks: 0, impressions: 2, ctr: 0, position: 50 },
    ]);
  });

  it('«Web (basada en texto)», la cabecera «Filtrar» y «Aparición en búsquedas»', () => {
    const parsed = parseGscExport([
      { name: 'Aspecto', rows: [['Aparición en búsquedas', ...header]] },
      {
        name: 'Dispositivos',
        rows: [
          ['Dispositivo', ...header],
          ['Móviles', '17', '271', '0.0627', '7.64'],
          ['Ordenador', '3', '552', '0.0054', '24.93'],
        ],
      },
      {
        name: 'Fechas',
        rows: [
          ['Fecha', ...header],
          ['2026-10-06', '0', '2', '0', '50'],
        ],
      },
      {
        name: 'Filtros',
        rows: [
          ['Filtrar', 'Valor'],
          ['Tipo de búsqueda', 'Web (basada en texto)'],
          ['Fecha', 'Últimos 16 meses'],
        ],
      },
    ]);
    expect(parsed.filtered).toBe(false);
    expect(parsed.filters).toHaveLength(2);
    expect(parsed.tabs.find((t) => t.dimension === 'device')!.rows.map((r) => r.value)).toEqual([
      'MOBILE',
      'DESKTOP',
    ]);
    expect(detectGscTab('x', ['Aparición en búsquedas'])?.tab).toBe('search_appearance');
  });
});
