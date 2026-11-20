import { nextScheduleRun, previousPeriod } from '../report-schedule-time';

describe('report-schedule-time', () => {
  const tz = 'Europe/Madrid';

  it('semanal: el próximo lunes a las 8:00 (hora de Madrid)', () => {
    // Miércoles 18-nov-2026 12:00 UTC → lunes 23-nov 8:00 Madrid = 7:00 UTC.
    const next = nextScheduleRun(
      { frequency: 'weekly', weekday: 1, dayOfMonth: null, hour: 8 },
      tz,
      new Date('2026-11-18T12:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-11-23T07:00:00.000Z');
  });

  it('mensual: si hoy ya pasó la hora, el mes siguiente', () => {
    const next = nextScheduleRun(
      { frequency: 'monthly', weekday: null, dayOfMonth: 1, hour: 8 },
      tz,
      new Date('2026-12-01T10:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-01-01T07:00:00.000Z');
  });

  it('periodo anterior: semana de lunes a domingo y mes natural', () => {
    const at = new Date('2026-11-23T07:00:00Z'); // lunes
    expect(previousPeriod('weekly', tz, at)).toMatchObject({
      from: '2026-11-16',
      to: '2026-11-22',
    });
    expect(previousPeriod('monthly', tz, new Date('2026-12-01T07:00:00Z'))).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      month: '2026-11',
    });
  });
});
