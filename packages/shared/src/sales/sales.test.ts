import { describe, expect, it } from 'vitest';

import {
  cadenceDueDates,
  forecastRevenueCommission,
  normalizeSalesCode,
  renderSalesTemplate,
  revenueCommission,
  SalesBulkLeadActionSchema,
  salesLeadSize,
  SalesLeadsQuerySchema,
  salesSignupUrl,
  saleTierAmount,
  saleTierExtra,
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
  it('lleva el código en el parámetro team', () => {
    expect(salesSignupUrl('https://trasteros.pro/', 'ANA7K2')).toBe(
      'https://trasteros.pro/register?team=ANA7K2',
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

describe('tramos y previsión de comisiones', () => {
  const tiers = [
    { fromSales: 3, amount: 70 },
    { fromSales: 6, amount: 90 },
  ];

  it('el fijo del tramo más alto alcanzado', () => {
    expect(saleTierAmount(tiers, 50, 2)).toBe(50);
    expect(saleTierAmount(tiers, 50, 3)).toBe(70);
    expect(saleTierAmount(tiers, 50, 8)).toBe(90);
    expect(saleTierExtra(tiers, 50, 4)).toBe(80);
    expect(saleTierExtra(tiers, 50, 1)).toBe(0);
    // Un tramo por debajo del fijo normal no resta.
    expect(saleTierAmount([{ fromSales: 2, amount: 10 }], 50, 5)).toBe(50);
  });

  it('prevé el % de cada cliente mientras dura su plazo', () => {
    const months = ['2026-12', '2027-01', '2027-02'];
    const out = forecastRevenueCommission({
      clients: [
        { monthlyNet: 100, firstPaidMonth: '2026-11' },
        { monthlyNet: 50, firstPaidMonth: '2027-01' },
      ],
      revenuePct: 10,
      revenueMonths: 2,
      months,
    });
    // El primero cuenta noviembre y diciembre; el segundo enero y febrero.
    expect(out).toEqual([10, 5, 5]);
    expect(
      forecastRevenueCommission({
        clients: [{ monthlyNet: 100, firstPaidMonth: '2026-11' }],
        revenuePct: 10,
        revenueMonths: null,
        months,
      }),
    ).toEqual([10, 10, 10]);
  });
});

describe('cartera del comercial', () => {
  it('saca el tamaño de lo que escribió en trasteros', () => {
    expect(salesLeadSize('300')).toBe('large');
    expect(salesLeadSize('unos 150')).toBe('large');
    expect(salesLeadSize('entre 50 y 80')).toBe('medium');
    expect(salesLeadSize('20')).toBe('small');
    expect(salesLeadSize('muchos')).toBe('unknown');
    expect(salesLeadSize(null)).toBe('unknown');
  });

  it('valida la lista: orden, filtros y límite', () => {
    expect(SalesLeadsQuerySchema.parse({ sort: 'priority', limit: '20', search: '' })).toEqual({
      sort: 'priority',
      limit: 20,
    });
    expect(SalesLeadsQuerySchema.safeParse({ sort: 'otro' }).success).toBe(false);
    expect(SalesLeadsQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(
      SalesBulkLeadActionSchema.safeParse({
        leadIds: [],
        action: { type: 'move', status: 'contacted' },
      }).success,
    ).toBe(false);
    expect(
      SalesBulkLeadActionSchema.safeParse({
        leadIds: ['00000000-0000-4000-8000-000000000000'],
        action: { type: 'move', status: 'customer' },
      }).success,
    ).toBe(false);
  });
});
