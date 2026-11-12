import { describe, expect, it } from 'vitest';

import { DunningSettingsSchema, dunningPreview } from './dunning';

const base = {
  firstReminderDays: 1,
  secondReminderDays: 7,
  lateFeeEnabled: true,
  lateFeeType: 'percentage' as const,
  lateFeeValue: 5,
  lateFeeGraceDays: 7,
  accessCutMode: 'all' as const,
  accessCutDays: 14,
  legalNoticeDays: 30,
  collectionsEnabled: true,
};

describe('vista previa del escalado', () => {
  it('pone cada paso en su fecha y en orden', () => {
    const steps = dunningPreview('2026-11-28', base);
    expect(steps.map((s) => [s.key, s.date])).toEqual([
      ['due', '2026-11-28'],
      ['first_reminder', '2026-11-29'],
      ['second_reminder', '2026-12-05'],
      ['late_fee', '2026-12-05'],
      ['access_block', '2026-12-12'],
      ['legal_notice', '2026-12-28'],
    ]);
    expect(steps.find((s) => s.key === 'late_fee')?.label).toBe('Recargo por mora del 5 %');
  });

  it('sin recargo ni corte no salen; con «solo adicionales», lo dice', () => {
    const off = dunningPreview('2026-01-31', {
      ...base,
      lateFeeEnabled: false,
      accessCutMode: 'none',
      collectionsEnabled: false,
    });
    expect(off.map((s) => s.key)).toEqual([
      'due',
      'first_reminder',
      'second_reminder',
      'legal_notice',
    ]);
    expect(off.at(-1)?.label).toBe('Aviso legal (aviso al equipo)');
    const extras = dunningPreview('2026-01-31', { ...base, accessCutMode: 'extras' });
    expect(extras.find((s) => s.key === 'access_block')?.label).toBe(
      'Corte de los accesos adicionales',
    );
  });

  it('el segundo recordatorio va después del primero', () => {
    const { collectionsEnabled: _c, ...input } = base;
    expect(DunningSettingsSchema.safeParse({ ...input, secondReminderDays: 1 }).success).toBe(
      false,
    );
    expect(DunningSettingsSchema.safeParse(input).success).toBe(true);
  });

  it('un recargo en porcentaje no pasa del 100 %; en euros, sí', () => {
    const { collectionsEnabled: _c, ...input } = base;
    expect(DunningSettingsSchema.safeParse({ ...input, lateFeeValue: 150 }).success).toBe(false);
    expect(
      DunningSettingsSchema.safeParse({ ...input, lateFeeType: 'fixed', lateFeeValue: 150 })
        .success,
    ).toBe(true);
  });
});
