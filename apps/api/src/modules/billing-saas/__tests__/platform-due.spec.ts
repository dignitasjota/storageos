import { addMonthsUtc, periodsOwed, subscriptionDueDate } from '../platform-due';

describe('platform-due', () => {
  it('addMonthsUtc no desborda el fin de mes', () => {
    const jan31 = new Date('2026-01-31T00:00:00Z');
    expect(addMonthsUtc(jan31, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonthsUtc(jan31, 2).toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(addMonthsUtc(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });

  it('periodsOwed cuenta una cuota por cada periodo empezado', () => {
    const since = new Date('2026-01-10T00:00:00Z');
    expect(periodsOwed(since, new Date('2026-01-20T00:00:00Z'), 1, false)).toBe(1);
    expect(periodsOwed(since, new Date('2026-02-10T00:00:00Z'), 1, false)).toBe(2);
    expect(periodsOwed(since, new Date('2026-04-15T00:00:00Z'), 1, false)).toBe(4);
    expect(periodsOwed(since, new Date('2026-04-15T00:00:00Z'), 12, false)).toBe(1);
    expect(periodsOwed(since, new Date('2026-04-15T00:00:00Z'), 1, true)).toBe(1);
  });

  it('subscriptionDueDate: Stripe desde el inicio del periodo que falló', () => {
    const base = {
      currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
      manualExtensionDays: 3,
    };
    expect(
      subscriptionDueDate({ ...base, billingMode: 'stripe', stripeSubscriptionId: 'sub_1' })
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-03-04');
    expect(
      subscriptionDueDate({ ...base, billingMode: 'manual', stripeSubscriptionId: null }),
    ).toEqual(base.currentPeriodEnd);
  });
});
