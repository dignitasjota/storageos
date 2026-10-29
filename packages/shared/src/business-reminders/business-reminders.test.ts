import { describe, expect, it } from 'vitest';

import {
  CreateBusinessReminderSchema,
  REMINDER_TEMPLATES,
  addMonthsToDate,
  fiscalNextDueDate,
  fiscalTemplateOccurrences,
  nextReminderDueDate,
  reminderNoticeKind,
  reminderState,
  shiftWeekend,
} from './index';

describe('fechas de los vencimientos', () => {
  it('suma meses ajustando al último día', () => {
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDate('2026-11-15', 3)).toBe('2027-02-15');
    expect(nextReminderDueDate('2026-10-29', 'yearly', null)).toBe('2027-10-29');
    expect(nextReminderDueDate('2026-10-29', 'custom', 24)).toBe('2028-10-29');
    expect(nextReminderDueDate('2026-10-29', 'none', null)).toBeNull();
  });

  it('el estado depende de los días que faltan', () => {
    expect(reminderState('active', -1)).toBe('overdue');
    expect(reminderState('active', 7)).toBe('soon');
    expect(reminderState('active', 8)).toBe('upcoming');
    expect(reminderState('paused', -3)).toBe('paused');
  });
});

describe('qué aviso toca hoy', () => {
  const base = {
    dueDate: '2026-11-30',
    notifyDaysBefore: [30, 7, 1, 0],
    overdueReminders: true,
    overdueMaxDays: 3,
  };

  it('el hito más cercano ya alcanzado (uno, no tres)', () => {
    expect(reminderNoticeKind({ ...base, today: '2026-10-01' })).toBeNull();
    expect(reminderNoticeKind({ ...base, today: '2026-10-31' })).toBe('d30');
    expect(reminderNoticeKind({ ...base, today: '2026-11-20' })).toBe('d30');
    expect(reminderNoticeKind({ ...base, today: '2026-11-25' })).toBe('d7');
    expect(reminderNoticeKind({ ...base, today: '2026-11-29' })).toBe('d1');
    expect(reminderNoticeKind({ ...base, today: '2026-11-30' })).toBe('d0');
  });

  it('vencido: un aviso al día hasta el máximo', () => {
    expect(reminderNoticeKind({ ...base, today: '2026-12-02' })).toBe('overdue:2026-12-02');
    expect(reminderNoticeKind({ ...base, today: '2026-12-04' })).toBeNull();
    expect(
      reminderNoticeKind({ ...base, overdueReminders: false, today: '2026-12-01' }),
    ).toBeNull();
  });

  it('pospuesto: nada hasta el día elegido', () => {
    const snoozed = { ...base, snoozedUntil: '2026-11-28' };
    expect(reminderNoticeKind({ ...snoozed, today: '2026-11-26' })).toBeNull();
    expect(reminderNoticeKind({ ...snoozed, today: '2026-11-28' })).toBe('snooze:2026-11-28');
    expect(reminderNoticeKind({ ...snoozed, today: '2026-11-29' })).toBe('d1');
  });
});

describe('plantillas fiscales', () => {
  it('cada fecha en su próximo vencimiento, sin fines de semana', () => {
    const t = REMINDER_TEMPLATES.find((x) => x.key === 'fiscal_303')!;
    const occ = fiscalTemplateOccurrences(t, '2026-10-29');
    expect(occ).toHaveLength(4);
    // 20 de abril de 2027 es martes; el 30 de enero de 2027 es sábado → lunes 1.
    expect(occ.find((o) => o.templateKey === 'fiscal_303:1-30')?.dueDate).toBe('2027-02-01');
    expect(occ.find((o) => o.templateKey === 'fiscal_303:10-20')?.dueDate).toBe('2027-10-20');
    expect(shiftWeekend('2026-06-20')).toBe('2026-06-22');
  });

  it('el siguiente vuelve al día oficial', () => {
    expect(fiscalNextDueDate('fiscal_303:1-30', '2027-02-01')).toBe('2028-01-31');
    expect(fiscalNextDueDate('fiscal_111:4-20', '2027-04-20')).toBe('2028-04-20');
    expect(fiscalNextDueDate('business_domain', '2027-04-20')).toBeNull();
  });
});

describe('validación', () => {
  it('pide al menos un aviso y personas si se eligen', () => {
    const ok = CreateBusinessReminderSchema.safeParse({
      title: 'Dominio',
      category: 'domain',
      dueDate: '2026-12-01',
      notifyDaysBefore: [7, 30, 7],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.notifyDaysBefore).toEqual([30, 7]);
    const noChannel = CreateBusinessReminderSchema.safeParse({
      title: 'Dominio',
      category: 'domain',
      dueDate: '2026-12-01',
      notifyEmail: false,
      notifyInApp: false,
      notifyPush: false,
    });
    expect(noChannel.success).toBe(false);
    const noPeople = CreateBusinessReminderSchema.safeParse({
      title: 'Dominio',
      category: 'domain',
      dueDate: '2026-12-01',
      recipientMode: 'users',
    });
    expect(noPeople.success).toBe(false);
    const custom = CreateBusinessReminderSchema.safeParse({
      title: 'Certificado',
      category: 'license',
      dueDate: '2026-12-01',
      recurrence: 'custom',
    });
    expect(custom.success).toBe(false);
  });
});
