import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFITABILITY_INPUT,
  ProfitabilityInputSchema,
  computeProfitability,
} from './profitability';

describe('calculadora de rentabilidad', () => {
  it('ingresos, gastos, beneficio, equilibrio y recuperación de la inversión', () => {
    const r = computeProfitability(DEFAULT_PROFITABILITY_INPUT);
    // 100 trasteros × 80 % × 60 € = 4.800 €; gastos 3.800 €.
    expect(r.rentedUnits).toBe(80);
    expect(r.monthlyRevenue).toBe(4800);
    expect(r.monthlyCosts).toBe(3800);
    expect(r.monthlyProfit).toBe(1000);
    expect(r.yearlyProfit).toBe(12000);
    expect(r.marginPct).toBe(20.8);
    // 3.800 / 60 = 63,3 → 64 trasteros (63,3 % de 6.000 €).
    expect(r.breakEvenUnits).toBe(64);
    expect(r.breakEvenOccupancyPct).toBe(63.3);
    expect(r.paybackMonths).toBe(60);
  });

  it('sin beneficio no hay recuperación; si ni lleno cubre los gastos, no hay equilibrio', () => {
    const r = computeProfitability({ ...DEFAULT_PROFITABILITY_INPUT, rent: 10_000 });
    expect(r.monthlyProfit).toBeLessThan(0);
    expect(r.paybackMonths).toBeNull();
    expect(r.breakEvenUnits).toBeNull();
    expect(r.breakEvenOccupancyPct).toBeNull();
    const empty = computeProfitability({ ...DEFAULT_PROFITABILITY_INPUT, occupancyPct: 0 });
    expect(empty.marginPct).toBeNull();
  });

  it('valida los límites y pone la inversión a 0 si no viene', () => {
    expect(
      ProfitabilityInputSchema.safeParse({ ...DEFAULT_PROFITABILITY_INPUT, units: 0 }).success,
    ).toBe(false);
    const { investment: _omit, ...rest } = DEFAULT_PROFITABILITY_INPUT;
    expect(ProfitabilityInputSchema.parse(rest).investment).toBe(0);
  });
});
