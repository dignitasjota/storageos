import { addBusinessHours } from '../business-hours';

/** Lunes a viernes de 9 a 14 (hora de Madrid). */
const HOURS = {
  mon: { open: '09:00', close: '14:00' },
  tue: { open: '09:00', close: '14:00' },
  wed: { open: '09:00', close: '14:00' },
  thu: { open: '09:00', close: '14:00' },
  fri: { open: '09:00', close: '14:00' },
  sat: null,
  sun: null,
};
const TZ = 'Europe/Madrid';

describe('addBusinessHours', () => {
  it('dentro del horario cuenta las horas tal cual', () => {
    // Lunes 10:00 de Madrid (08:00 UTC en verano) + 2 h = 12:00.
    const start = new Date('2026-06-15T08:00:00Z');
    expect(addBusinessHours(start, 2, HOURS, TZ).toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('de noche no corre: un contacto de las 23:00 vence a media mañana', () => {
    // Lunes 23:00 de Madrid + 2 h de atención = martes 11:00.
    const start = new Date('2026-06-15T21:00:00Z');
    expect(addBusinessHours(start, 2, HOURS, TZ).toISOString()).toBe('2026-06-16T09:00:00.000Z');
  });

  it('el fin de semana tampoco', () => {
    // Viernes 13:00 + 4 h = 1 h el viernes y 3 h el lunes → lunes 12:00.
    const start = new Date('2026-06-19T11:00:00Z');
    expect(addBusinessHours(start, 4, HOURS, TZ).toISOString()).toBe('2026-06-22T10:00:00.000Z');
  });

  it('sin ningún día abierto no se queda en un bucle', () => {
    const start = new Date('2026-06-15T08:00:00Z');
    const end = addBusinessHours(start, 1, { mon: null }, TZ);
    expect(end.getTime() - start.getTime()).toBeGreaterThanOrEqual(30 * 86_400_000);
  });
});
