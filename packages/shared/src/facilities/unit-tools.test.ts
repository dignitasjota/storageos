import { describe, expect, it } from 'vitest';

import { bulkUnitPrice, lostUnitIncome, nextUnitCode } from './unit-tools';

describe('bulkUnitPrice', () => {
  it('fija el precio o sube un porcentaje', () => {
    expect(bulkUnitPrice(50, { mode: 'set', value: 60 })).toBe(60);
    expect(bulkUnitPrice(50, { mode: 'percent', value: 10 })).toBe(55);
    expect(bulkUnitPrice(33.33, { mode: 'percent', value: 3 })).toBe(34.33);
  });

  it('redondea al euro o a 5 €', () => {
    expect(bulkUnitPrice(47, { mode: 'percent', value: 5, round: 'euro' })).toBe(49);
    expect(bulkUnitPrice(47, { mode: 'percent', value: 5, round: 'five' })).toBe(50);
    expect(bulkUnitPrice(52, { mode: 'set', value: 52, round: 'five' })).toBe(50);
  });
});

describe('lostUnitIncome', () => {
  it('cuenta el mes como 30 días', () => {
    expect(lostUnitIncome(60, 15)).toBe(30);
    expect(lostUnitIncome(50, 0)).toBe(0);
  });
});

describe('nextUnitCode', () => {
  it('sigue la serie conservando las cifras', () => {
    expect(nextUnitCode('A-09')).toBe('A-10');
    expect(nextUnitCode('B7')).toBe('B8');
    expect(nextUnitCode('12B-3')).toBe('12B-4');
    expect(nextUnitCode('P-099-X')).toBe('P-100-X');
  });

  it('sin número añade uno', () => {
    expect(nextUnitCode('Sotano')).toBe('Sotano-2');
  });
});
