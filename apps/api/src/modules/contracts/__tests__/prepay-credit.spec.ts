import { creditForLine, unusedPrepaidMonths } from '../prepay-credit';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('unusedPrepaidMonths', () => {
  it('anual con alta el 10-ene y baja el 5-mar: meses por aniversario, 2 consumidos → 10', () => {
    expect(unusedPrepaidMonths(d('2026-01-10'), 12, d('2026-03-05'))).toBe(10);
    expect(unusedPrepaidMonths(d('2026-01-10'), 12, d('2026-03-10'))).toBe(9);
  });

  it('baja el mismo día del alta cuenta el primer mes como consumido', () => {
    expect(unusedPrepaidMonths(d('2026-01-10'), 12, d('2026-01-10'))).toBe(11);
  });

  it('baja el día anterior al aniversario: el mes en curso ya está consumido', () => {
    expect(unusedPrepaidMonths(d('2026-01-10'), 6, d('2026-02-09'))).toBe(5);
    expect(unusedPrepaidMonths(d('2026-01-10'), 6, d('2026-02-10'))).toBe(4);
  });

  it('baja tras consumir todo el periodo → 0', () => {
    expect(unusedPrepaidMonths(d('2026-01-10'), 6, d('2026-08-01'))).toBe(0);
  });

  it('mensual no genera abono', () => {
    expect(unusedPrepaidMonths(d('2026-01-10'), 1, d('2026-01-12'))).toBe(0);
  });

  it('alta a fin de mes no desborda (31-ene + 1 mes = 28-feb)', () => {
    expect(unusedPrepaidMonths(d('2026-01-31'), 12, d('2026-02-27'))).toBe(11);
    expect(unusedPrepaidMonths(d('2026-01-31'), 12, d('2026-02-28'))).toBe(10);
  });
});

describe('creditForLine', () => {
  it('prorratea al céntimo', () => {
    expect(creditForLine(1080, 12, 9)).toBe(810);
    expect(creditForLine(100, 12, 5)).toBe(41.67);
    expect(creditForLine(100, 12, 0)).toBe(0);
  });
});
