import { zonedDayStart, zonedNextDayStart } from '../format';

describe('zonedDayStart (días en hora de Madrid)', () => {
  it('en invierno el día empieza a las 23:00 UTC del anterior', () => {
    expect(zonedDayStart('2027-01-01').toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(zonedNextDayStart('2026-12-31').toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('en verano a las 22:00 UTC', () => {
    expect(zonedDayStart('2026-07-15').toISOString()).toBe('2026-07-14T22:00:00.000Z');
  });

  it('los días del cambio de hora', () => {
    // 29-mar-2026: a las 02:00 se pasa a las 03:00; la medianoche sigue en UTC+1.
    expect(zonedDayStart('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(zonedDayStart('2026-03-30').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    // 25-oct-2026: a las 03:00 se vuelve a las 02:00; la medianoche aún en UTC+2.
    expect(zonedDayStart('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(zonedDayStart('2026-10-26').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('fecha no válida', () => {
    expect(Number.isNaN(zonedDayStart('no-fecha').getTime())).toBe(true);
  });
});
