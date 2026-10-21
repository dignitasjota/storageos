import { describe, expect, it } from 'vitest';

import { ConnectGa4Schema, summarizeGa4, type Ga4SourceRowInput } from './ga4';

const row = (
  date: string,
  source: string,
  sessions: number,
  extra: Partial<Ga4SourceRowInput> = {},
) => ({
  date,
  source,
  medium: source === 'google' ? 'organic' : 'social',
  campaign: '(not set)',
  device: 'mobile',
  sessions,
  engagedSessions: Math.floor(sessions / 2),
  pageViews: sessions * 2,
  keyEvents: 0,
  ...extra,
});

describe('ConnectGa4Schema', () => {
  it('acepta el número o properties/<número>', () => {
    expect(ConnectGa4Schema.parse({ propertyId: '123456789' }).propertyId).toBe('123456789');
    expect(ConnectGa4Schema.parse({ propertyId: ' properties/123456789 ' }).propertyId).toBe(
      '123456789',
    );
  });

  it('rechaza el ID de medición G-…', () => {
    expect(ConnectGa4Schema.safeParse({ propertyId: 'G-ABC123' }).success).toBe(false);
  });
});

describe('summarizeGa4', () => {
  it('suma el periodo, lo compara con el anterior y agrupa por origen', () => {
    const report = summarizeGa4(
      [
        row('2026-10-20', 'google', 10, { keyEvents: 2 }),
        row('2026-10-21', 'google', 6, { device: 'desktop' }),
        row('2026-10-21', 'instagram', 4),
        // Periodo anterior (7 días antes).
        row('2026-10-14', 'google', 8),
        // Fuera de los dos periodos.
        row('2026-09-01', 'google', 100),
      ],
      [
        { date: '2026-10-21', pagePath: '/', pageViews: 12, sessions: 9 },
        { date: '2026-10-20', pagePath: '/', pageViews: 3, sessions: 2 },
        { date: '2026-10-21', pagePath: '/precios', pageViews: 5, sessions: 4 },
      ],
      7,
      '2026-10-21',
    );
    expect(report.from).toBe('2026-10-15');
    expect(report.totals).toEqual({
      sessions: 20,
      engagedSessions: 10,
      engagementRate: 0.5,
      pageViews: 40,
      keyEvents: 2,
    });
    expect(report.previous.sessions).toBe(8);
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)).toEqual({ date: '2026-10-21', sessions: 10 });
    expect(report.sources.map((s) => [s.source, s.sessions])).toEqual([
      ['google', 16],
      ['instagram', 4],
    ]);
    expect(report.pages[0]).toEqual({ path: '/', pageViews: 15, sessions: 11 });
    expect(report.devices).toEqual([
      { device: 'mobile', sessions: 14 },
      { device: 'desktop', sessions: 6 },
    ]);
  });

  it('sin datos no inventa la tasa de interacción', () => {
    const report = summarizeGa4([], [], 30, '2026-10-21');
    expect(report.totals.engagementRate).toBeNull();
    expect(report.daily).toHaveLength(30);
  });
});
