import { describe, expect, it } from 'vitest';

import {
  churnRiskOf,
  DEFAULT_HEALTH_CLIENT_WEIGHTS,
  HealthClientWeightsSchema,
  isAnomalous,
  linearForecast,
  mainDragOf,
  parseHealthWeights,
  payProbabilityOf,
} from './health-insights';

describe('churnRiskOf', () => {
  it('alto por puntuación baja o por una caída grande', () => {
    expect(churnRiskOf(40, null)).toBe('high');
    expect(churnRiskOf(90, -15)).toBe('high');
  });
  it('medio con puntuación tibia o caída moderada', () => {
    expect(churnRiskOf(60, 2)).toBe('medium');
    expect(churnRiskOf(90, -6)).toBe('medium');
  });
  it('bajo si está sana y estable', () => {
    expect(churnRiskOf(85, 0)).toBe('low');
    expect(churnRiskOf(85, null)).toBe('low');
  });
});

describe('payProbabilityOf', () => {
  it('sigue la activación', () => {
    expect(payProbabilityOf(70, 7).pct).toBe(70);
  });
  it('baja si le quedan pocos días con poca activación', () => {
    expect(payProbabilityOf(40, 2)).toEqual({ pct: 30, level: 'medium' });
    expect(payProbabilityOf(50, 0).pct).toBe(30);
  });
  it('sube un poco si tiene tiempo por delante', () => {
    expect(payProbabilityOf(20, 20)).toEqual({ pct: 30, level: 'medium' });
  });
  it('con un contrato firmado no baja de 40', () => {
    expect(payProbabilityOf(20, 0, true).pct).toBe(40);
  });
});

describe('pesos', () => {
  it('deben sumar 100', () => {
    expect(HealthClientWeightsSchema.safeParse(DEFAULT_HEALTH_CLIENT_WEIGHTS).success).toBe(true);
    expect(
      HealthClientWeightsSchema.safeParse({ ...DEFAULT_HEALTH_CLIENT_WEIGHTS, support: 10 })
        .success,
    ).toBe(false);
  });
  it('lo guardado que no suma 100 vuelve a los de por defecto', () => {
    expect(parseHealthWeights({ engagement: 99 }, DEFAULT_HEALTH_CLIENT_WEIGHTS)).toEqual(
      DEFAULT_HEALTH_CLIENT_WEIGHTS,
    );
    const custom = { ...DEFAULT_HEALTH_CLIENT_WEIGHTS, engagement: 40, adoption: 5 };
    expect(parseHealthWeights(custom, DEFAULT_HEALTH_CLIENT_WEIGHTS)).toEqual(custom);
  });
});

describe('mainDragOf', () => {
  it('elige el factor que más puntos quita y su acción', () => {
    const drag = mainDragOf([
      { key: 'engagement', label: 'Actividad', score: 0, weight: 0.3, counted: true, detail: 'x' },
      { key: 'billing', label: 'Facturación', score: 40, weight: 0.2, counted: true, detail: 'y' },
      { key: 'portal', label: 'Área', score: 0, weight: 0, counted: false, detail: 'z' },
    ]);
    expect(drag?.key).toBe('engagement');
    expect(drag?.lostPoints).toBe(60);
    expect(drag?.action.label).toBe('Escribir');
  });
  it('sin nada que reste no sugiere nada', () => {
    expect(
      mainDragOf([
        { key: 'support', label: 'S', score: 100, weight: 1, counted: true, detail: '' },
      ]),
    ).toBeNull();
  });
});

describe('linearForecast e isAnomalous', () => {
  it('prolonga la tendencia', () => {
    expect(linearForecast([100, 200, 300], 2)).toEqual([400, 500]);
    expect(linearForecast([5], 2)).toEqual([5, 5]);
    expect(linearForecast([300, 200, 100], 4)).toEqual([0, 0, 0, 0]);
  });
  it('anómalo: por encima del mínimo y de N veces la media', () => {
    expect(isAnomalous(400, 100, 3, 50)).toBe(true);
    expect(isAnomalous(250, 100, 3, 50)).toBe(false);
    expect(isAnomalous(40, 0, 3, 50)).toBe(false);
    expect(isAnomalous(60, 0, 3, 50)).toBe(true);
  });
});
