import { describe, expect, it } from 'vitest';

import { firstMonthCents, firstMonthPlan } from './first-month';

describe('firstMonthPlan', () => {
  it('entrada el día 1: el mes entero', () => {
    const p = firstMonthPlan('2026-11-01', 20);
    expect(p).toMatchObject({
      periodEnd: '2026-11-30',
      fullFirstMonth: true,
      includesNextMonth: false,
      billingStartsOn: '2026-12-01',
    });
    expect(firstMonthCents(5000, p)).toEqual({ firstMonth: 5000, nextMonth: 0, total: 5000 });
  });

  it('antes del día límite: solo los días que quedan', () => {
    const p = firstMonthPlan('2026-10-05', 20);
    expect(p).toMatchObject({ periodEnd: '2026-10-31', days: 27, includesNextMonth: false });
    expect(firstMonthCents(3100, p).total).toBe(2700);
  });

  it('desde el día límite: los días que quedan más el mes siguiente', () => {
    const p = firstMonthPlan('2026-10-28', 20);
    expect(p).toMatchObject({
      periodEnd: '2026-11-30',
      days: 4,
      includesNextMonth: true,
      nextMonthStart: '2026-11-01',
      billingStartsOn: '2026-12-01',
    });
    expect(firstMonthCents(3100, p)).toEqual({ firstMonth: 400, nextMonth: 3100, total: 3500 });
  });

  it('cambio de año y desactivado', () => {
    expect(firstMonthPlan('2026-12-20', 20)).toMatchObject({
      periodEnd: '2027-01-31',
      billingStartsOn: '2027-02-01',
    });
    expect(firstMonthPlan('2026-12-28', null).includesNextMonth).toBe(false);
  });
});
