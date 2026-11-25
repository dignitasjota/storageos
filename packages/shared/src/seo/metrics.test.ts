import { describe, expect, it } from 'vitest';

import { daysBetween } from '../business-reminders';
import { aggregateSearchMetrics } from '../web/search-console';

import { seoChange, seoPeriodRange, summarizeSeoSite, undetailedSearches } from './metrics';

import { seoDomainOfProperty } from './index';

describe('aggregateSearchMetrics', () => {
  it('CTR = clics ÷ impresiones y posición ponderada por impresiones', () => {
    const t = aggregateSearchMetrics([
      { clicks: 10, impressions: 100, position: 2 },
      { clicks: 0, impressions: 300, position: 10 },
    ]);
    expect(t.clicks).toBe(10);
    expect(t.impressions).toBe(400);
    expect(t.ctr).toBe(0.025);
    // (2·100 + 10·300) / 400 = 8
    expect(t.position).toBe(8);
  });

  it('sin filas no hay posición ni CTR', () => {
    expect(aggregateSearchMetrics([])).toEqual({
      clicks: 0,
      impressions: 0,
      position: null,
      ctr: null,
    });
  });
});

describe('seoPeriodRange', () => {
  it('7, 28 y 90 días que acaban en el último dato y los anteriores', () => {
    expect(seoPeriodRange('2026-11-20', 7)).toEqual({
      from: '2026-11-14',
      to: '2026-11-20',
      previousFrom: '2026-11-07',
      previousTo: '2026-11-13',
    });
    const r28 = seoPeriodRange('2026-03-01', 28);
    expect(r28.from).toBe('2026-02-02');
    expect(daysBetween(r28.previousFrom, r28.previousTo)).toBe(27);
    expect(daysBetween(seoPeriodRange('2026-11-20', 90).from, '2026-11-20')).toBe(89);
  });
});

describe('seoChange', () => {
  it('porcentaje, puntos de CTR y puestos que sube', () => {
    const c = seoChange(
      { clicks: 150, impressions: 1000, ctr: 0.15, position: 4 },
      { clicks: 100, impressions: 1000, ctr: 0.1, position: 6.5 },
    );
    expect(c).toEqual({ clicksPct: 50, impressionsPct: 0, ctrDiff: 0.05, positionDiff: 2.5 });
    expect(
      seoChange(
        { clicks: 5, impressions: 0, ctr: null, position: null },
        { clicks: 0, impressions: 0, ctr: null, position: null },
      ),
    ).toEqual({ clicksPct: null, impressionsPct: null, ctrDiff: null, positionDiff: null });
  });
});

describe('undetailedSearches', () => {
  it('total del sitio menos la suma por búsqueda, nunca negativo', () => {
    const site = { clicks: 20, impressions: 1000, ctr: 0.02, position: 5 };
    expect(
      undetailedSearches(site, { clicks: 15, impressions: 800, ctr: null, position: null }),
    ).toEqual({ clicks: 5, impressions: 200, impressionsShare: 0.2 });
    expect(
      undetailedSearches(site, { clicks: 25, impressions: 1200, ctr: null, position: null }),
    ).toEqual({ clicks: 0, impressions: 0, impressionsShare: 0 });
  });
});

describe('summarizeSeoSite', () => {
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
    return { date: d, clicks: i < 7 ? 1 : 3, impressions: 100, position: i < 7 ? 10 : 5 };
  });

  it('compara con el periodo anterior y reparte por dispositivo', () => {
    const s = summarizeSeoSite({
      days: 7,
      site: days,
      devices: days.slice(7).flatMap((d) => [
        { ...d, device: 'MOBILE', clicks: 2, impressions: 60 },
        { ...d, device: 'DESKTOP', clicks: 1, impressions: 40 },
      ]),
      queryTotals: { clicks: 14, impressions: 500, ctr: null, position: null },
    });
    expect(s.lastDate).toBe('2026-11-14');
    expect(s.from).toBe('2026-11-08');
    expect(s.current).toMatchObject({ clicks: 21, impressions: 700, ctr: 0.03, position: 5 });
    expect(s.previous).toMatchObject({ clicks: 7, impressions: 700, position: 10 });
    expect(s.change).toMatchObject({ clicksPct: 200, positionDiff: 5 });
    expect(s.devices.map((d) => d.device)).toEqual(['MOBILE', 'DESKTOP']);
    expect(s.devices[0]!.clickShare).toBe(0.667);
    expect(s.undetailed).toEqual({ clicks: 7, impressions: 200, impressionsShare: 0.286 });
    expect(s.daily).toHaveLength(7);
  });

  it('sin datos de todo el periodo anterior no compara', () => {
    const s = summarizeSeoSite({ days: 7, site: days.slice(3), devices: [], queryTotals: null });
    expect(s.previous).toBeNull();
    expect(s.change).toBeNull();
    expect(s.undetailed).toBeNull();
  });
});

describe('seoDomainOfProperty', () => {
  it('saca el dominio sin www de cualquier propiedad', () => {
    expect(seoDomainOfProperty('sc-domain:Guardalobox.es')).toBe('guardalobox.es');
    expect(seoDomainOfProperty('https://www.trasteros.pro/blog/')).toBe('trasteros.pro');
    expect(seoDomainOfProperty('http://ejemplo.es:8080/')).toBe('ejemplo.es');
  });
});
