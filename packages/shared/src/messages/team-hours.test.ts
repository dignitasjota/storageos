import { describe, expect, it } from 'vitest';

import {
  MAX_CLOSED_DATES,
  normalizeTeamHours,
  pruneClosedDates,
  TeamHoursSchema,
} from './team-hours';

describe('horario de atención del equipo', () => {
  it('admite el horario guardado antes, sin días cerrados', () => {
    const parsed = TeamHoursSchema.safeParse({ mon: { open: '09:00', close: '14:00' } });
    expect(parsed.success).toBe(true);
  });

  it('admite turno partido y días cerrados', () => {
    const parsed = TeamHoursSchema.safeParse({
      mon: { open: '09:00', close: '14:00', open2: '16:00', close2: '20:00' },
      closedDates: ['2026-12-25', '2027-01-06'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rechaza fechas que no existen y demasiados días', () => {
    expect(TeamHoursSchema.safeParse({ closedDates: ['2026-02-30'] }).success).toBe(false);
    expect(TeamHoursSchema.safeParse({ closedDates: ['25/12/2026'] }).success).toBe(false);
    const many = Array.from({ length: MAX_CLOSED_DATES + 1 }, (_, i) =>
      new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10),
    );
    expect(TeamHoursSchema.safeParse({ closedDates: many }).success).toBe(false);
  });

  it('quita los días pasados y los repetidos, y ordena', () => {
    expect(
      pruneClosedDates(['2027-01-06', '2026-11-01', '2026-12-25', '2027-01-06'], '2026-11-20'),
    ).toEqual(['2026-12-25', '2027-01-06']);
    // Hoy todavía cuenta.
    expect(pruneClosedDates(['2026-11-20'], '2026-11-20')).toEqual(['2026-11-20']);
  });

  it('sin días cerrados que conservar, el campo desaparece', () => {
    const hours = { mon: { open: '09:00', close: '14:00' }, closedDates: ['2020-01-01'] };
    expect(normalizeTeamHours(hours, '2026-11-20')).toEqual({
      mon: { open: '09:00', close: '14:00' },
    });
  });
});
