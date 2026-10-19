import { describe, expect, it } from 'vitest';

import { allocateInstallments, buildInstallments } from './collections-ops';

describe('planes de pago', () => {
  it('reparte el total en cuotas mensuales y la última absorbe los céntimos', () => {
    const plan = buildInstallments(100, 3, '2026-01-31', 'monthly');
    expect(plan).toEqual([
      { dueDate: '2026-01-31', amount: 33.33 },
      { dueDate: '2026-02-28', amount: 33.33 },
      { dueDate: '2026-03-31', amount: 33.34 },
    ]);
    expect(buildInstallments(90, 3, '2026-05-01', 'biweekly').map((i) => i.dueDate)).toEqual([
      '2026-05-01',
      '2026-05-15',
      '2026-05-29',
    ]);
  });

  it('aplica lo cobrado a las cuotas en orden y marca la que se retrasa', () => {
    const plan = buildInstallments(90, 3, '2026-05-01', 'monthly');
    const res = allocateInstallments(plan, 40, '2026-06-09', 7);
    expect(res.map((r) => r.status)).toEqual(['paid', 'late', 'pending']);
    expect(res[1]!.paid).toBe(10);
    expect(allocateInstallments(plan, 40, '2026-06-05', 7)[1]!.status).toBe('partial');
  });
});
