import { describe, expect, it } from 'vitest';

import { assistantRespondsNow, hasOpenDay, isWithinHours } from './index';

const hours = { mon: { open: '09:00', close: '14:00' }, sat: null };

describe('horario del asistente de WhatsApp', () => {
  // Martes 3 de noviembre de 2026, 10:00 en Madrid (09:00 UTC).
  const mondayTen = new Date('2026-11-03T09:00:00Z');
  // Mismo martes a las 15:00 en Madrid.
  const mondayThree = new Date('2026-11-03T14:00:00Z');

  it('respeta el horario en la zona del negocio', () => {
    expect(isWithinHours(hours, 'Europe/Madrid', mondayTen)).toBe(false);
    expect(
      isWithinHours({ tue: { open: '09:00', close: '14:00' } }, 'Europe/Madrid', mondayTen),
    ).toBe(true);
    expect(
      isWithinHours({ tue: { open: '09:00', close: '14:00' } }, 'Europe/Madrid', mondayThree),
    ).toBe(false);
    expect(isWithinHours(null, 'Europe/Madrid', mondayTen)).toBe(false);
  });

  it('decide si responde la IA según el modo', () => {
    const team = { tue: { open: '09:00', close: '14:00' } };
    expect(assistantRespondsNow('always', team, 'Europe/Madrid', mondayTen)).toBe(true);
    expect(assistantRespondsNow('outside', team, 'Europe/Madrid', mondayTen)).toBe(false);
    expect(assistantRespondsNow('outside', team, 'Europe/Madrid', mondayThree)).toBe(true);
    expect(assistantRespondsNow('inside', team, 'Europe/Madrid', mondayTen)).toBe(true);
    // Sin horario configurado: «solo fuera» responde siempre.
    expect(assistantRespondsNow('outside', null, 'Europe/Madrid', mondayTen)).toBe(true);
  });

  it('cuenta el segundo turno de un horario partido', () => {
    const split = { tue: { open: '08:00', close: '09:30', open2: '14:30', close2: '18:00' } };
    // 10:00 → entre turnos.
    expect(isWithinHours(split, 'Europe/Madrid', mondayTen)).toBe(false);
    // 15:00 → segundo turno.
    expect(isWithinHours(split, 'Europe/Madrid', mondayThree)).toBe(true);
  });

  it('trata un día cerrado como fuera de horario todo el día', () => {
    const team = { tue: { open: '09:00', close: '14:00' }, closedDates: ['2026-11-03'] };
    expect(isWithinHours(team, 'Europe/Madrid', mondayTen)).toBe(false);
    expect(assistantRespondsNow('outside', team, 'Europe/Madrid', mondayTen)).toBe(true);
    // Otro martes que no es festivo sí está dentro.
    expect(isWithinHours(team, 'Europe/Madrid', new Date('2026-11-10T09:00:00Z'))).toBe(true);
  });

  it('el festivo se mira en la zona del negocio, no en UTC', () => {
    // Miércoles 4 a las 00:30 en Madrid = martes 3 a las 23:30 UTC.
    const lateNight = new Date('2026-11-03T23:30:00Z');
    const allDay = { wed: { open: '00:00', close: '00:00' } };
    expect(isWithinHours(allDay, 'Europe/Madrid', lateNight)).toBe(true);
    expect(
      isWithinHours({ ...allDay, closedDates: ['2026-11-04'] }, 'Europe/Madrid', lateNight),
    ).toBe(false);
    // El festivo del martes ya no cuenta a esa hora en Madrid.
    expect(
      isWithinHours({ ...allDay, closedDates: ['2026-11-03'] }, 'Europe/Madrid', lateNight),
    ).toBe(true);
  });

  it('un cierre a las 00:00 llega hasta medianoche', () => {
    const evening = { tue: { open: '18:00', close: '00:00' } };
    // 23:30 del martes en Madrid.
    expect(isWithinHours(evening, 'Europe/Madrid', new Date('2026-11-03T22:30:00Z'))).toBe(true);
    // 17:00 del martes.
    expect(isWithinHours(evening, 'Europe/Madrid', new Date('2026-11-03T16:00:00Z'))).toBe(false);
  });

  it('turno partido con el segundo turno hasta medianoche', () => {
    const split = { tue: { open: '09:00', close: '13:00', open2: '20:00', close2: '00:00' } };
    expect(isWithinHours(split, 'Europe/Madrid', mondayTen)).toBe(true);
    expect(isWithinHours(split, 'Europe/Madrid', mondayThree)).toBe(false);
    expect(isWithinHours(split, 'Europe/Madrid', new Date('2026-11-03T22:59:00Z'))).toBe(true);
  });

  it('sabe si hay algún día marcado', () => {
    expect(hasOpenDay(null)).toBe(false);
    expect(hasOpenDay({})).toBe(false);
    expect(hasOpenDay({ mon: null, sun: null })).toBe(false);
    expect(hasOpenDay({ fri: { open: '09:00', close: '14:00' } })).toBe(true);
  });
});
