import { describe, expect, it } from 'vitest';

import {
  CreateUnitCessionSchema,
  addMonthsToDay,
  UpdateUnitCessionSchema,
  cessionDaysBetween,
  cessionExtendedEnd,
  cessionIsExpired,
  cessionIsExpiring,
  cessionMonthsBetween,
  cessionNextReview,
  cessionRemainingText,
  cessionState,
  isRealIsoDay,
} from './index';

describe('isRealIsoDay', () => {
  it('solo admite días que existen', () => {
    expect(isRealIsoDay('2028-02-29')).toBe(true);
    expect(isRealIsoDay('2027-02-29')).toBe(false);
    expect(isRealIsoDay('2027-02-31')).toBe(false);
    expect(isRealIsoDay('2027-13-01')).toBe(false);
    expect(isRealIsoDay('2027-00-10')).toBe(false);
    expect(isRealIsoDay('27-01-01')).toBe(false);
  });

  it('los esquemas rechazan una fecha imposible', () => {
    const r = CreateUnitCessionSchema.safeParse({ holderName: 'Ana', endsOn: '2027-02-31' });
    expect(r.success).toBe(false);
    expect(UpdateUnitCessionSchema.safeParse({ endsOn: '2027-13-01' }).success).toBe(false);
  });
});

describe('vencida y vence pronto', () => {
  it('el día de fin sigue en plazo', () => {
    expect(cessionIsExpired(0)).toBe(false);
    expect(cessionIsExpiring(0)).toBe(true);
    expect(cessionIsExpired(-1)).toBe(true);
    expect(cessionIsExpiring(-1)).toBe(false);
    expect(cessionIsExpiring(7)).toBe(true);
    expect(cessionIsExpiring(8)).toBe(false);
  });
});

describe('cessionExtendedEnd', () => {
  it('suma desde el fin si no ha vencido y desde hoy si ya venció', () => {
    expect(cessionExtendedEnd('2026-11-21', '2026-12-10', 1)).toBe('2027-01-10');
    expect(cessionExtendedEnd('2026-11-21', '2026-11-21', 1)).toBe('2026-12-21');
    expect(cessionExtendedEnd('2026-11-21', '2026-10-01', 1)).toBe('2026-12-21');
  });
});

describe('cessionRemainingText', () => {
  it('cuenta meses y días', () => {
    expect(cessionRemainingText('2026-11-21', '2027-01-26')).toBe('2 meses y 5 días');
    expect(cessionRemainingText('2026-11-21', '2026-12-21')).toBe('1 mes');
    expect(cessionRemainingText('2026-11-21', '2026-11-30')).toBe('9 días');
    expect(cessionRemainingText('2026-11-21', '2026-11-21')).toBe('0 días');
  });

  it('el mes anterior al fin manda en los días', () => {
    expect(cessionRemainingText('2026-01-31', '2026-03-01')).toBe('1 mes y 1 día');
  });

  it('una fecha pasada no tiene tiempo restante', () => {
    expect(cessionRemainingText('2026-11-21', '2026-11-20')).toBeNull();
  });
});

describe('addMonthsToDay', () => {
  it('ajusta a fin de mes', () => {
    expect(addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDay('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsToDay('2026-11-21', 3)).toBe('2027-02-21');
  });
});

describe('cessionDaysBetween', () => {
  it('cuenta días naturales', () => {
    expect(cessionDaysBetween('2026-11-21', '2026-11-28')).toBe(7);
    expect(cessionDaysBetween('2026-11-21', '2026-11-20')).toBe(-1);
  });
});

describe('CreateUnitCessionSchema', () => {
  it('pide a quién se cede', () => {
    expect(CreateUnitCessionSchema.safeParse({ months: 3 }).success).toBe(false);
    expect(CreateUnitCessionSchema.safeParse({ holderName: 'Ana', months: 3 }).success).toBe(true);
  });

  it('pide los meses o la fecha, una de las dos', () => {
    expect(CreateUnitCessionSchema.safeParse({ holderName: 'Ana' }).success).toBe(false);
    expect(
      CreateUnitCessionSchema.safeParse({ holderName: 'Ana', months: 2, endsOn: '2027-01-01' })
        .success,
    ).toBe(false);
    expect(
      CreateUnitCessionSchema.safeParse({ holderName: 'Ana', endsOn: '2027-01-01' }).success,
    ).toBe(true);
  });
});

describe('UpdateUnitCessionSchema', () => {
  it('no admite meses y fecha a la vez', () => {
    expect(UpdateUnitCessionSchema.safeParse({ months: 1, endsOn: '2027-01-01' }).success).toBe(
      false,
    );
    expect(UpdateUnitCessionSchema.safeParse({ months: 1 }).success).toBe(true);
    expect(UpdateUnitCessionSchema.safeParse({}).success).toBe(false);
  });
});

describe('mejoras de las cesiones', () => {
  it('avisa con los días elegidos', () => {
    expect(cessionIsExpiring(10, 15)).toBe(true);
    expect(cessionIsExpiring(1, 0)).toBe(false);
    expect(cessionIsExpiring(0, 0)).toBe(true);
  });

  it('estado de la cesión', () => {
    expect(cessionState({ ended: false, daysLeft: null, noticeDays: 7 })).toBe('on_time');
    expect(cessionState({ ended: false, daysLeft: 20, noticeDays: 7 })).toBe('on_time');
    expect(cessionState({ ended: false, daysLeft: 5, noticeDays: 7 })).toBe('expiring');
    expect(cessionState({ ended: false, daysLeft: 0, noticeDays: 7 })).toBe('due_today');
    expect(cessionState({ ended: false, daysLeft: -1, noticeDays: 7 })).toBe('expired');
    expect(cessionState({ ended: true, daysLeft: null, noticeDays: 7 })).toBe('ended');
  });

  it('sin fecha de fin: ampliar cuenta desde hoy y no queda tiempo en palabras', () => {
    expect(cessionExtendedEnd('2027-03-10', null, 1)).toBe('2027-04-10');
    expect(cessionRemainingText('2027-03-10', null)).toBeNull();
  });

  it('recordatorio cada N meses', () => {
    expect(cessionNextReview('2027-01-31', 3)).toBe('2027-04-30');
    expect(cessionMonthsBetween('2027-01-15', '2027-04-14')).toBe(2);
    expect(cessionMonthsBetween('2027-01-15', '2027-04-15')).toBe(3);
  });

  it('una sola forma de fijar el fin', () => {
    const base = { holderName: 'Ana' };
    expect(CreateUnitCessionSchema.safeParse({ ...base, openEnded: true }).success).toBe(true);
    expect(CreateUnitCessionSchema.safeParse({ ...base, openEnded: true, months: 2 }).success).toBe(
      false,
    );
    expect(
      CreateUnitCessionSchema.safeParse({ ...base, months: 2, reviewEveryMonths: 3 }).success,
    ).toBe(false);
    expect(CreateUnitCessionSchema.safeParse({ ...base, months: 2, noticeDays: 4 }).success).toBe(
      false,
    );
    expect(
      UpdateUnitCessionSchema.safeParse({ openEnded: true, endsOn: '2027-03-01' }).success,
    ).toBe(false);
  });
});
