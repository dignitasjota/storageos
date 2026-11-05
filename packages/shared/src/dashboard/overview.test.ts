import { describe, expect, it } from 'vitest';

import { DASHBOARD_CARDS, dashboardPeriodRange, resolveDashboardLayout } from './overview';

describe('dashboardPeriodRange', () => {
  it('compara el mes en curso con el anterior hasta el mismo día', () => {
    expect(dashboardPeriodRange('month', '2026-05-10')).toEqual({
      from: '2026-05-01',
      to: '2026-05-11',
      previousFrom: '2026-04-01',
      previousTo: '2026-04-11',
    });
  });

  it('el 31 se compara con el último día de un mes más corto', () => {
    expect(dashboardPeriodRange('month', '2026-03-31').previousTo).toBe('2026-03-01');
  });

  it('el mes pasado va entero', () => {
    expect(dashboardPeriodRange('last_month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2026-01-01',
      previousFrom: '2025-11-01',
      previousTo: '2025-12-01',
    });
  });

  it('los últimos meses son contiguos con el periodo anterior', () => {
    const r = dashboardPeriodRange('3m', '2026-05-31');
    expect(r).toEqual({
      from: '2026-03-01',
      to: '2026-06-01',
      previousFrom: '2025-12-01',
      previousTo: '2026-03-01',
    });
  });

  it('el año se compara con el anterior hasta la misma fecha', () => {
    expect(dashboardPeriodRange('year', '2024-02-29')).toEqual({
      from: '2024-01-01',
      to: '2024-03-01',
      previousFrom: '2023-01-01',
      previousTo: '2023-03-01',
    });
  });
});

describe('resolveDashboardLayout', () => {
  const all = DASHBOARD_CARDS.map((c) => c.id);

  it('sin nada guardado da el orden por defecto', () => {
    expect(resolveDashboardLayout({})).toEqual({ order: all, hidden: [] });
    expect(resolveDashboardLayout(null)).toEqual({ order: all, hidden: [] });
  });

  it('respeta el orden, quita lo retirado y repetido y añade lo nuevo', () => {
    const { order, hidden } = resolveDashboardLayout({
      order: ['kpis', 'retirada', 'suggestions', 'kpis'],
      hidden: ['seo', 'retirada'],
    });
    expect(order.indexOf('kpis')).toBeLessThan(order.indexOf('suggestions'));
    expect(new Set(order).size).toBe(all.length);
    expect(order).toHaveLength(all.length);
    expect(hidden).toEqual(['seo']);
  });
});
