import { describe, expect, it } from 'vitest';

import { aggregateSearchMetrics } from '../web/search-console';

import {
  seoComparison,
  seoPeriodCovered,
  seoSameWindow,
  seoPanelRange,
  seoRowVariation,
  seoShiftMonths,
  seoShiftYears,
  seoTopN,
  seoTotalsFromSums,
} from './panel';

describe('seoShiftMonths / seoShiftYears', () => {
  it('ajusta al último día del mes si no existe', () => {
    expect(seoShiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(seoShiftMonths('2026-01-15', -2)).toBe('2025-11-15');
    expect(seoShiftYears('2028-02-29', -1)).toBe('2027-02-28');
    expect(seoShiftYears('2026-11-25', -1)).toBe('2025-11-25');
  });
});

describe('seoPanelRange', () => {
  it('días: acaba en el último dato, con el anterior y el del año pasado', () => {
    expect(seoPanelRange({ period: '28d', lastDate: '2026-11-24' })).toEqual({
      period: '28d',
      from: '2026-10-28',
      to: '2026-11-24',
      days: 28,
      previousFrom: '2026-09-30',
      previousTo: '2026-10-27',
      yearAgoFrom: '2025-10-28',
      yearAgoTo: '2025-11-24',
    });
  });

  it('meses: del día siguiente a hace N meses', () => {
    const r = seoPanelRange({ period: '6m', lastDate: '2026-11-24' })!;
    expect(r.from).toBe('2026-05-25');
    expect(r.days).toBe(184);
    expect(r.previousTo).toBe('2026-05-24');
    const y = seoPanelRange({ period: '12m', lastDate: '2026-11-24' })!;
    expect(y.from).toBe('2025-11-25');
    expect(y.days).toBe(365);
  });

  it('personalizado: se ordena, no pasa del último dato y es null si no es válido', () => {
    const r = seoPanelRange({
      period: 'custom',
      lastDate: '2026-11-24',
      from: '2026-12-10',
      to: '2026-11-01',
    })!;
    expect(r).toMatchObject({ from: '2026-11-01', to: '2026-11-24', days: 24 });
    expect(seoPanelRange({ period: 'custom', lastDate: '2026-11-24', from: 'x', to: null })).toBe(
      null,
    );
    const long = seoPanelRange({
      period: 'custom',
      lastDate: '2026-11-24',
      from: '2020-01-01',
      to: '2026-11-24',
    })!;
    expect(long.days).toBe(1096);
  });
});

describe('seoTotalsFromSums', () => {
  it('da lo mismo que sumar las filas', () => {
    const rows = [
      { clicks: 10, impressions: 100, position: 2 },
      { clicks: 0, impressions: 300, position: 10 },
      { clicks: 3, impressions: 0, position: 50 },
    ];
    const sums = {
      clicks: 13,
      impressions: 400,
      weightedPosition: 2 * 100 + 10 * 300,
      positionSum: 62,
      rows: 3,
    };
    expect(seoTotalsFromSums(sums)).toEqual(aggregateSearchMetrics(rows));
    expect(
      seoTotalsFromSums({
        clicks: 0,
        impressions: 0,
        weightedPosition: 0,
        positionSum: 0,
        rows: 0,
      }),
    ).toEqual({ clicks: 0, impressions: 0, position: null, ctr: null });
  });
});

describe('seoComparison', () => {
  const cur = { clicks: 120, impressions: 1000, ctr: 0.12, position: 5 };
  const prev = { clicks: 100, impressions: 1000, ctr: 0.1, position: 6 };
  it('compara si hay datos de todo el periodo', () => {
    expect(seoComparison(cur, prev, true)).toEqual({
      totals: prev,
      change: { clicksPct: 20, impressionsPct: 0, ctrDiff: 0.02, positionDiff: 1 },
    });
  });
  it('si no, no compara', () => {
    expect(seoComparison(cur, prev, false)).toEqual({ totals: null, change: null });
  });
});

describe('seoTopN', () => {
  it('los N primeros por clics y el resto sumado', () => {
    const rows = [
      { key: 'esp', clicks: 50, impressions: 500, position: 4 },
      { key: 'fra', clicks: 5, impressions: 100, position: 8 },
      { key: 'ita', clicks: 5, impressions: 200, position: 10 },
      { key: 'deu', clicks: 1, impressions: 100, position: 20 },
    ];
    const { top, rest } = seoTopN(rows, 2, 61);
    expect(top.map((t) => t.key)).toEqual(['esp', 'ita']);
    expect(top[0]!.clickShare).toBe(0.82);
    expect(rest).toEqual({
      key: 'rest',
      count: 2,
      clickShare: 0.098,
      totals: { clicks: 6, impressions: 200, ctr: 0.03, position: 14 },
    });
    expect(seoTopN(rows, 10, 61).rest).toBeNull();
  });
});

describe('seoRowVariation', () => {
  it('diferencia de clics, porcentaje y puestos que sube', () => {
    expect(seoRowVariation({ clicks: 15, position: 4 }, { clicks: 10, position: 6.5 })).toEqual({
      clicksChange: 5,
      clicksPct: 50,
      positionDiff: 2.5,
    });
    expect(seoRowVariation({ clicks: 3, position: 4 }, { clicks: 0, position: null })).toEqual({
      clicksChange: 3,
      clicksPct: null,
      positionDiff: null,
    });
    expect(seoRowVariation({ clicks: 3, position: 4 }, null).clicksChange).toBeNull();
  });
});

describe('seoPeriodCovered', () => {
  it('exige datos de casi todos los días del periodo', () => {
    const base = { firstDate: '2024-01-01', from: '2025-01-01', to: '2025-01-10' };
    expect(seoPeriodCovered({ ...base, daysWithData: 10 })).toBe(true);
    expect(seoPeriodCovered({ ...base, daysWithData: 9 })).toBe(true);
    expect(seoPeriodCovered({ ...base, daysWithData: 5 })).toBe(false);
    expect(seoPeriodCovered({ ...base, firstDate: '2025-01-02', daysWithData: 10 })).toBe(false);
    expect(seoPeriodCovered({ ...base, firstDate: null, daysWithData: 10 })).toBe(false);
  });
  it('reconoce el mismo periodo con un día de diferencia', () => {
    expect(seoSameWindow('2024-11-25', '2024-11-25')).toBe(true);
    expect(seoSameWindow('2024-11-24', '2024-11-25')).toBe(true);
    expect(seoSameWindow('2024-11-20', '2024-11-25')).toBe(false);
  });
});
