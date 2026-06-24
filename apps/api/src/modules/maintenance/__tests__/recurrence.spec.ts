import { firstOccurrence, nextOccurrence, scheduleLabel } from '@storageos/shared';

import type { RecurrenceSpec } from '@storageos/shared';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('Recurrencia de mantenimiento', () => {
  it('daily: cada N días', () => {
    const spec: RecurrenceSpec = { freq: 'daily', interval: 3, weekdays: [], dayOfMonth: null };
    expect(iso(firstOccurrence(spec, d('2026-06-10')))).toBe('2026-06-10');
    expect(iso(nextOccurrence(spec, d('2026-06-10')))).toBe('2026-06-13');
  });

  it('weekly: días concretos de la semana', () => {
    // Lunes (1) y jueves (4). 2026-06-10 es miércoles.
    const spec: RecurrenceSpec = {
      freq: 'weekly',
      interval: 1,
      weekdays: [1, 4],
      dayOfMonth: null,
    };
    expect(iso(firstOccurrence(spec, d('2026-06-10')))).toBe('2026-06-11'); // jueves
    expect(iso(nextOccurrence(spec, d('2026-06-11')))).toBe('2026-06-15'); // lunes siguiente
  });

  it('monthly: día del mes cada N meses (trimestral)', () => {
    const spec: RecurrenceSpec = { freq: 'monthly', interval: 3, weekdays: [], dayOfMonth: 1 };
    expect(iso(firstOccurrence(spec, d('2026-06-10')))).toBe('2026-07-01'); // día 1 ya pasó en junio
    expect(iso(nextOccurrence(spec, d('2026-07-01')))).toBe('2026-10-01'); // +3 meses
  });

  it('monthly: si el día aún no ha pasado, es este mes', () => {
    const spec: RecurrenceSpec = { freq: 'monthly', interval: 1, weekdays: [], dayOfMonth: 20 };
    expect(iso(firstOccurrence(spec, d('2026-06-10')))).toBe('2026-06-20');
  });

  it('scheduleLabel legible', () => {
    expect(scheduleLabel({ freq: 'monthly', interval: 6, weekdays: [], dayOfMonth: 1 })).toBe(
      'Cada 6 meses, día 1',
    );
    expect(scheduleLabel({ freq: 'daily', interval: 1, weekdays: [], dayOfMonth: null })).toBe(
      'Cada día',
    );
  });
});
