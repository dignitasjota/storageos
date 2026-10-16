import { addMonths } from '../first-invoice.service';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('addMonths (primer pago por meses)', () => {
  it('se queda en el último día si el mes de destino es más corto', () => {
    expect(ymd(addMonths(new Date('2026-01-31T00:00:00Z'), 1))).toBe('2026-02-28');
    expect(ymd(addMonths(new Date('2026-11-30T00:00:00Z'), 3))).toBe('2027-02-28');
    expect(ymd(addMonths(new Date('2028-01-31T00:00:00Z'), 1))).toBe('2028-02-29');
  });

  it('mantiene el día cuando existe', () => {
    expect(ymd(addMonths(new Date('2026-03-15T00:00:00Z'), 3))).toBe('2026-06-15');
    expect(ymd(addMonths(new Date('2026-01-31T00:00:00Z'), 12))).toBe('2027-01-31');
  });
});
