import { describe, expect, it } from 'vitest';

import {
  concentrationShares,
  gatewayFee,
  paybackMonths,
  percentile,
  projectMrr,
  quarterOfMonth,
} from './metrics-insights';

describe('metrics-insights', () => {
  it('percentil con interpolación', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.25)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.25)).toBe(2);
    expect(percentile([0, 10], 0.75)).toBe(7.5);
  });

  it('proyecta el MRR con el NRR y las altas, sin bajar de 0', () => {
    expect(projectMrr(100, 2, 10, 100)).toEqual([110, 120]);
    expect(projectMrr(100, 1, 0, 90)).toEqual([90]);
    expect(projectMrr(100, 2, 5, null)).toEqual([105, 110]);
    expect(projectMrr(10, 1, -50, null)).toEqual([0]);
  });

  it('comisión de la pasarela: % más fijo', () => {
    expect(gatewayFee(100, 1.5, 0.25)).toBe(1.75);
    expect(gatewayFee(0, 1.5, 0.25)).toBe(0);
    expect(gatewayFee(50, 0, 0.3)).toBe(0.3);
  });

  it('concentración: peso de los mayores clientes e índice', () => {
    expect(concentrationShares([])).toEqual({ top1Pct: 0, top5Pct: 0, top10Pct: 0, hhi: 0 });
    const c = concentrationShares([50, 25, 25]);
    expect(c.top1Pct).toBe(50);
    expect(c.top5Pct).toBe(100);
    expect(c.hhi).toBe(3750);
    expect(concentrationShares([100]).hhi).toBe(10_000);
  });

  it('meses de recuperación del coste de adquisición', () => {
    expect(paybackMonths(300, 100, 75)).toBe(4);
    expect(paybackMonths(null, 100, 75)).toBeNull();
    expect(paybackMonths(0, 100, 75)).toBe(0);
    expect(paybackMonths(300, 0, 75)).toBeNull();
    expect(paybackMonths(200, 100, null)).toBe(2);
  });

  it('trimestre de un mes', () => {
    expect(quarterOfMonth(1)).toBe(1);
    expect(quarterOfMonth(3)).toBe(1);
    expect(quarterOfMonth(4)).toBe(2);
    expect(quarterOfMonth(12)).toBe(4);
  });
});
