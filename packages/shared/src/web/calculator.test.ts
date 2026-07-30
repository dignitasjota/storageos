import { describe, expect, it } from 'vitest';

import { STORAGE_ITEMS, computeStorageM2, recommendStorageUnit } from './calculator';

import type { RecommendableUnit } from './calculator';

describe('computeStorageM2', () => {
  it('devuelve 0 sin objetos', () => {
    expect(computeStorageM2({})).toBe(0);
    expect(computeStorageM2({ sofa_3: 0 })).toBe(0);
  });

  it('suma con margen del 15% y redondea a 1 decimal', () => {
    // sofa_3 = 1.5, cama_doble = 1.2 → 2.7 × 1.15 = 3.105 → 3.1
    expect(computeStorageM2({ sofa_3: 1, cama_doble: 1 })).toBe(3.1);
  });

  it('multiplica por cantidad e ignora claves desconocidas', () => {
    // caja_m = 0.1 × 10 = 1.0 × 1.15 = 1.15 → 1.2
    expect(computeStorageM2({ caja_m: 10, no_existe: 5 })).toBe(1.2);
  });

  it('ignora cantidades negativas', () => {
    expect(computeStorageM2({ sofa_3: -2 })).toBe(0);
  });
});

describe('recommendStorageUnit', () => {
  const units: RecommendableUnit[] = [
    { name: 'Pequeño', areaM2: 2, priceMonthly: 30, available: 3 },
    { name: 'Mediano', areaM2: 5, priceMonthly: 55, available: 2 },
    { name: 'Grande', areaM2: 10, priceMonthly: 90, available: 1 },
  ];

  it('elige el más pequeño que cubre los m²', () => {
    expect(recommendStorageUnit(3, units)?.name).toBe('Mediano');
    expect(recommendStorageUnit(2, units)?.name).toBe('Pequeño');
    expect(recommendStorageUnit(5, units)?.name).toBe('Mediano');
  });

  it('si ninguno llega, devuelve el más grande disponible', () => {
    expect(recommendStorageUnit(50, units)?.name).toBe('Grande');
  });

  it('ignora tipos sin área o sin disponibilidad', () => {
    const mixed: RecommendableUnit[] = [
      { name: 'Sin área', areaM2: null, priceMonthly: 20, available: 5 },
      { name: 'Agotado', areaM2: 3, priceMonthly: 40, available: 0 },
      { name: 'Válido', areaM2: 8, priceMonthly: 70, available: 1 },
    ];
    expect(recommendStorageUnit(2, mixed)?.name).toBe('Válido');
  });

  it('devuelve null si no hay candidatos', () => {
    expect(recommendStorageUnit(3, [])).toBeNull();
    expect(
      recommendStorageUnit(3, [{ name: 'x', areaM2: null, priceMonthly: 1, available: 1 }]),
    ).toBeNull();
  });

  it('el catálogo tiene objetos y todos con m² positivo', () => {
    expect(STORAGE_ITEMS.length).toBeGreaterThan(10);
    expect(STORAGE_ITEMS.every((i) => i.m2 > 0)).toBe(true);
  });
});
