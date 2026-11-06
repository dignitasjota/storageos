import { describe, expect, it } from 'vitest';

import { facilityCompleteness } from './completeness';
import {
  dayHoursText,
  hasOpeningHours,
  isAllDay,
  isOpenNow,
  upcomingExceptions,
} from './opening-hours';
import { DayHoursSchema, OpeningHoursSchema } from './schemas';

const labels = { closed: 'Cerrado', allDay: '24 horas', and: 'y' };
/** Martes 10 de noviembre de 2026 a las 10:30 en Madrid. */
const tuesday = new Date('2026-11-10T09:30:00Z');
const at = (hour: number) => new Date(`2026-11-10T${String(hour - 1).padStart(2, '0')}:30:00Z`);

describe('horario del local', () => {
  it('turno partido', () => {
    const hours = { tue: { open: '09:00', close: '14:00', open2: '16:00', close2: '20:00' } };
    expect(isOpenNow(hours, 'Europe/Madrid', [], at(10))).toBe(true);
    expect(isOpenNow(hours, 'Europe/Madrid', [], at(15))).toBe(false);
    expect(isOpenNow(hours, 'Europe/Madrid', [], at(17))).toBe(true);
    expect(isOpenNow(hours, 'Europe/Madrid', [], at(21))).toBe(false);
    expect(dayHoursText(hours.tue, labels)).toBe('09:00–14:00 y 16:00–20:00');
  });

  it('24 horas y cierre a medianoche', () => {
    const allDay = { open: '00:00', close: '00:00' };
    expect(isAllDay(allDay)).toBe(true);
    expect(isOpenNow({ tue: allDay }, 'Europe/Madrid', [], tuesday)).toBe(true);
    expect(dayHoursText(allDay, labels)).toBe('24 horas');
    expect(isOpenNow({ tue: { open: '22:00', close: '00:00' } }, 'Europe/Madrid', [], at(23))).toBe(
      true,
    );
  });

  it('el festivo manda sobre la semana', () => {
    const hours = { tue: { open: '09:00', close: '20:00' } };
    const closed = [{ date: '2026-11-10', label: 'Fiesta local', hours: null }];
    expect(isOpenNow(hours, 'Europe/Madrid', closed, tuesday)).toBe(false);
    const short = [{ date: '2026-11-10', hours: { open: '11:00', close: '13:00' } }];
    expect(isOpenNow(hours, 'Europe/Madrid', short, tuesday)).toBe(false);
    expect(isOpenNow(hours, 'Europe/Madrid', short, at(12))).toBe(true);
    // El día se mira en la hora del local: las 23:30 UTC ya son el miércoles en Madrid.
    const wednesday = { wed: { open: '00:00', close: '00:00' } };
    const midnight = new Date('2026-11-10T23:30:00Z');
    expect(isOpenNow(wednesday, 'Europe/Madrid', [], midnight)).toBe(true);
    expect(
      isOpenNow(wednesday, 'Europe/Madrid', [{ date: '2026-11-11', hours: null }], midnight),
    ).toBe(false);
  });

  it('próximos días especiales', () => {
    const list = [
      { date: '2026-12-25', label: 'Navidad', hours: null },
      { date: '2026-11-01', hours: null },
      { date: '2026-11-20', hours: null },
    ];
    expect(upcomingExceptions(list, 'Europe/Madrid', 30, tuesday).map((e) => e.date)).toEqual([
      '2026-11-20',
    ]);
    expect(upcomingExceptions(list, 'Europe/Madrid', 60, tuesday).map((e) => e.date)).toEqual([
      '2026-11-20',
      '2026-12-25',
    ]);
  });

  it('valida los dos turnos', () => {
    const ok = { open: '09:00', close: '14:00', open2: '16:00', close2: '20:00' };
    expect(DayHoursSchema.safeParse(ok).success).toBe(true);
    expect(DayHoursSchema.safeParse({ ...ok, close2: undefined }).success).toBe(false);
    expect(DayHoursSchema.safeParse({ ...ok, open2: '13:00' }).success).toBe(false);
    expect(DayHoursSchema.safeParse({ ...ok, close2: '15:00' }).success).toBe(false);
    expect(DayHoursSchema.safeParse({ ...ok, close2: '00:00' }).success).toBe(true);
    expect(OpeningHoursSchema.safeParse({ mon: null, tue: ok }).success).toBe(true);
  });

  it('sabe si tiene horario', () => {
    expect(hasOpeningHours({})).toBe(false);
    expect(hasOpeningHours({ mon: null })).toBe(false);
    expect(hasOpeningHours({ mon: { open: '09:00', close: '10:00' } })).toBe(true);
  });

  it('la ficha completa dice lo que falta', () => {
    const empty = {
      images: [],
      openingHours: {},
      address: null,
      contactPhone: null,
      latitude: null,
      directions: null,
    };
    expect(facilityCompleteness(empty)).toEqual({
      percent: 0,
      missing: ['photo', 'hours', 'address', 'phone', 'map', 'directions'],
    });
    expect(
      facilityCompleteness({
        images: [{}],
        openingHours: { mon: { open: '09:00', close: '10:00' } },
        address: 'Calle 1',
        contactPhone: '600',
        latitude: 40,
        directions: null,
      }),
    ).toEqual({ percent: 83, missing: ['directions'] });
  });
});
