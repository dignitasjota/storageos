import { describe, expect, it } from 'vitest';

import {
  cadenceDueDates,
  normalizeSalesCode,
  renderSalesTemplate,
  revenueCommission,
  salesSignupUrl,
} from './index';

describe('normalizeSalesCode', () => {
  it('pasa a mayúsculas y quita separadores', () => {
    expect(normalizeSalesCode(' ana-7k2 ')).toBe('ANA7K2');
  });
  it('rechaza lo que no tiene la forma', () => {
    expect(normalizeSalesCode('ab')).toBeNull();
    expect(normalizeSalesCode('ABCDEFGHIJKLM')).toBeNull();
    expect(normalizeSalesCode(null)).toBeNull();
  });
});

describe('salesSignupUrl', () => {
  it('lleva el código en el parámetro comercial', () => {
    expect(salesSignupUrl('https://trasteros.pro/', 'ANA7K2')).toBe(
      'https://trasteros.pro/register?comercial=ANA7K2',
    );
  });
});

describe('renderSalesTemplate', () => {
  it('sustituye las variables conocidas y quita las vacías', () => {
    expect(
      renderSalesTemplate('Hola {nombre}, soy {comercial} {agenda}', {
        nombre: 'Marta',
        comercial: 'Ana',
        agenda: null,
      }),
    ).toBe('Hola Marta, soy Ana ');
  });
  it('deja como están las que no son variables', () => {
    expect(renderSalesTemplate('{otra} y {nombre}', { nombre: 'Luis' })).toBe('{otra} y Luis');
  });
});

describe('cadenceDueDates', () => {
  it('suma los días de cada paso, también al cambiar de mes', () => {
    expect(cadenceDueDates('2026-01-30', [{ day: 0 }, { day: 3 }, { day: 30 }])).toEqual([
      '2026-01-30',
      '2026-02-02',
      '2026-03-01',
    ]);
  });
});

describe('revenueCommission', () => {
  it('redondea a céntimos', () => {
    expect(revenueCommission(100, 10)).toBe(10);
    expect(revenueCommission(79.99, 12.5)).toBe(10);
  });
  it('sin base o sin porcentaje no hay comisión', () => {
    expect(revenueCommission(0, 10)).toBe(0);
    expect(revenueCommission(100, 0)).toBe(0);
  });
});
