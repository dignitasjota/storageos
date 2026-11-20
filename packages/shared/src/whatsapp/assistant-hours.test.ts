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

  it('sabe si hay algún día marcado', () => {
    expect(hasOpenDay(null)).toBe(false);
    expect(hasOpenDay({})).toBe(false);
    expect(hasOpenDay({ mon: null, sun: null })).toBe(false);
    expect(hasOpenDay({ fri: { open: '09:00', close: '14:00' } })).toBe(true);
  });
});
