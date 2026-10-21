import { describe, expect, it } from 'vitest';

import {
  areaSlugOfPage,
  ConnectSearchConsoleSchema,
  summarizeSearchConsole,
  type SearchConsoleRowInput,
} from './search-console';

const row = (
  date: string,
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number,
): SearchConsoleRowInput => ({ date, query, page, clicks, impressions, position });

describe('Search Console', () => {
  it('acepta propiedades de dominio y de prefijo de URL', () => {
    expect(
      ConnectSearchConsoleSchema.safeParse({ siteUrl: 'sc-domain:guardalobox.es' }).success,
    ).toBe(true);
    expect(
      ConnectSearchConsoleSchema.safeParse({ siteUrl: 'https://guardalobox.es/' }).success,
    ).toBe(true);
    expect(ConnectSearchConsoleSchema.safeParse({ siteUrl: 'guardalobox.es' }).success).toBe(false);
  });

  it('reconoce las páginas de zona', () => {
    expect(areaSlugOfPage('https://x.es/trasteros-en-mislata')).toBe('mislata');
    expect(areaSlugOfPage('https://trasteros.pro/s/demo/trasteros-en-paterna?x=1')).toBe('paterna');
    expect(areaSlugOfPage('https://x.es/precios')).toBeNull();
  });

  it('compara con el periodo anterior y avisa de lo que cae', () => {
    const page = 'https://x.es/trasteros-en-mislata';
    const rows = [
      // Periodo anterior (días 1-7): posición 4, 20 clics.
      ...Array.from({ length: 7 }, (_, i) =>
        row(`2026-10-0${i + 1}`, 'trasteros mislata', page, 3, 10, 4),
      ),
      // Periodo actual (días 8-14): posición 8, 7 clics.
      ...Array.from({ length: 7 }, (_, i) =>
        row(`2026-10-${String(i + 8).padStart(2, '0')}`, 'trasteros mislata', page, 1, 10, 8),
      ),
    ];
    const s = summarizeSearchConsole(rows, 7);
    expect(s).toMatchObject({ from: '2026-10-08', to: '2026-10-14', previousFrom: '2026-10-01' });
    expect(s.totals).toMatchObject({ clicks: 7, impressions: 70, position: 8 });
    expect(s.previousTotals).toMatchObject({ clicks: 21, position: 4 });
    expect(s.queries[0]).toMatchObject({ query: 'trasteros mislata', change: -4 });
    expect(s.pages[0]).toMatchObject({ areaSlug: 'mislata', previousClicks: 21 });
    expect(s.alerts.map((a) => a.kind).sort()).toEqual([
      'page_clicks_dropped',
      'page_dropped',
      'query_dropped',
    ]);
  });
});
