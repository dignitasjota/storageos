import { describe, expect, it } from 'vitest';

import {
  expenseAmounts,
  expenseBaseFromTotal,
  expenseCategoryLabel,
  nextRecurrenceDate,
  recurrenceDatesUntil,
  recurrencePending,
} from './index';

describe('expenseAmounts', () => {
  it('sin base: el importe es lo que cuesta y lo que se paga', () => {
    expect(expenseAmounts({ amount: 121 })).toEqual({
      broken: false,
      amount: 121,
      baseAmount: null,
      vatAmount: null,
      withholdingAmount: null,
      totalAmount: 121,
    });
  });

  it('con IVA deducible cuesta la base y se paga base + IVA', () => {
    expect(expenseAmounts({ baseAmount: 100, vatRate: 21 })).toMatchObject({
      broken: true,
      amount: 100,
      vatAmount: 21,
      totalAmount: 121,
    });
  });

  it('el IVA no deducible suma al gasto', () => {
    expect(expenseAmounts({ baseAmount: 100, vatRate: 21, vatDeductible: false }).amount).toBe(121);
  });

  it('la retención se descuenta de lo que se paga, no del gasto (alquiler con 19 %)', () => {
    expect(expenseAmounts({ baseAmount: 1000, vatRate: 21, withholdingRate: 19 })).toMatchObject({
      amount: 1000,
      vatAmount: 210,
      withholdingAmount: 190,
      totalAmount: 1020,
    });
  });

  it('redondea al céntimo', () => {
    expect(expenseAmounts({ baseAmount: 10.05, vatRate: 21 })).toMatchObject({
      vatAmount: 2.11,
      totalAmount: 12.16,
    });
  });

  it('la base a partir del total', () => {
    expect(expenseBaseFromTotal(121, 21, 0)).toBe(100);
    expect(expenseBaseFromTotal(1020, 21, 19)).toBe(1000);
  });
});

describe('expenseCategoryLabel', () => {
  it('de siempre, propia y borrada', () => {
    expect(expenseCategoryLabel('rent')).toBe('Alquiler');
    expect(expenseCategoryLabel('custom:abc', [{ id: 'abc', name: 'Limpieza' }])).toBe('Limpieza');
    expect(expenseCategoryLabel('custom:zzz', [])).toBe('Categoría borrada');
  });
});

describe('recurrencia', () => {
  const quarterly = {
    frequency: 'quarterly' as const,
    dayOfMonth: 5,
    startDate: '2026-01-01',
    endDate: null,
  };

  it('fechas trimestrales hasta hoy (el día de este mes aún no ha llegado)', () => {
    expect(recurrenceDatesUntil(quarterly, '2026-10-03')).toEqual([
      '2026-01-05',
      '2026-04-05',
      '2026-07-05',
    ]);
    expect(recurrenceDatesUntil(quarterly, '2026-10-05')).toEqual([
      '2026-01-05',
      '2026-04-05',
      '2026-07-05',
      '2026-10-05',
    ]);
  });

  it('respeta la fecha de fin', () => {
    expect(recurrenceDatesUntil({ ...quarterly, endDate: '2026-05-01' }, '2026-12-31')).toEqual([
      '2026-01-05',
      '2026-04-05',
    ]);
  });

  it('la próxima fecha', () => {
    expect(nextRecurrenceDate(quarterly, '2026-10-05')).toBe('2027-01-05');
    expect(nextRecurrenceDate(quarterly, '2026-02-10')).toBe('2026-04-05');
    expect(
      nextRecurrenceDate(
        { ...quarterly, frequency: 'yearly', startDate: '2026-03-01' },
        '2026-01-01',
      ),
    ).toBe('2026-03-05');
    expect(nextRecurrenceDate({ ...quarterly, endDate: '2026-12-31' }, '2026-10-05')).toBeNull();
  });

  it('lo pendiente: la última que llegó y las que se quedaron sin generar', () => {
    expect(recurrencePending(quarterly, '2026-10-20', '2026-04-01')).toEqual({
      current: '2026-10-05',
      missed: ['2026-07-05'],
    });
    expect(recurrencePending(quarterly, '2026-10-20', '2026-10-01')).toEqual({
      current: null,
      missed: [],
    });
  });
});
