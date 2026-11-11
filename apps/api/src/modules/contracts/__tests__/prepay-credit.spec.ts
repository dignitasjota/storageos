import {
  creditForLine,
  prepaidPeriodMonths,
  rentCreditWithoutDiscount,
  unusedPrepaidMonths,
} from '../prepay-credit';

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

describe('prepaidPeriodMonths', () => {
  it('reconoce los periodos de varios meses enteros', () => {
    expect(prepaidPeriodMonths(d('2026-11-15'), d('2027-02-14'))).toBe(3);
    expect(prepaidPeriodMonths(d('2026-01-10'), d('2027-01-09'))).toBe(12);
    expect(prepaidPeriodMonths(d('2026-01-31'), d('2026-07-30'))).toBe(6);
  });

  it('una factura mensual o la de un alta prorrateada no es un prepago', () => {
    expect(prepaidPeriodMonths(d('2026-11-01'), d('2026-11-30'))).toBe(0);
    // Alta el 28 con el mes siguiente incluido: del 28-oct al 30-nov.
    expect(prepaidPeriodMonths(d('2026-10-28'), d('2026-11-30'))).toBe(0);
  });
});

describe('rentCreditWithoutDiscount', () => {
  it('sin descuento coincide con la parte proporcional', () => {
    expect(rentCreditWithoutDiscount({ paid: 150, months: 3, unused: 2, monthlyPrice: 50 })).toBe(
      100,
    );
  });

  it('cupón de un mes gratis (paga 2 de 3): usado 1 mes, se le devuelve 1', () => {
    expect(rentCreditWithoutDiscount({ paid: 100, months: 3, unused: 2, monthlyPrice: 50 })).toBe(
      50,
    );
    // Usados 2: lo pagado ya cubre los meses usados a precio normal.
    expect(rentCreditWithoutDiscount({ paid: 100, months: 3, unused: 1, monthlyPrice: 50 })).toBe(
      0,
    );
  });

  it('prepago anual con un 10 %: los 6 meses usados a precio normal', () => {
    expect(rentCreditWithoutDiscount({ paid: 540, months: 12, unused: 6, monthlyPrice: 50 })).toBe(
      240,
    );
  });

  it('nunca más que la parte proporcional (si la cuota bajó después)', () => {
    expect(rentCreditWithoutDiscount({ paid: 150, months: 3, unused: 2, monthlyPrice: 40 })).toBe(
      100,
    );
  });

  it('nada si no quedan meses sin usar', () => {
    expect(rentCreditWithoutDiscount({ paid: 150, months: 3, unused: 0, monthlyPrice: 50 })).toBe(
      0,
    );
  });
});
