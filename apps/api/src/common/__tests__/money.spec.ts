import { addAmounts, isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../money';

describe('money helpers (aritmetica en centimos)', () => {
  it('addAmounts evita el drift clasico de floats (0.1 + 0.2 = 0.3 exacto)', () => {
    expect(addAmounts(0.1, 0.2)).toBe(0.3);
    expect(addAmounts(33.33, 66.67)).toBe(100);
    // El caso que rompia con floats puros: 20 pagos de 4.85
    let acc = 0;
    for (let i = 0; i < 20; i++) acc = addAmounts(acc, 4.85);
    expect(acc).toBe(97);
  });

  it('subtractAmounts es exacto', () => {
    expect(subtractAmounts(100, 99.99)).toBe(0.01);
    expect(subtractAmounts(0.3, 0.1)).toBe(0.2);
  });

  it('isAtLeast / isGreaterThan comparan sin epsilon', () => {
    expect(isAtLeast(addAmounts(0.1, 0.2), 0.3)).toBe(true);
    expect(isAtLeast(99.99, 100)).toBe(false);
    expect(isGreaterThan(100.01, 100)).toBe(true);
    expect(isGreaterThan(100, 100)).toBe(false);
  });

  it('acepta strings y objetos con toString (Decimal de Prisma)', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(addAmounts({ toString: () => '10.50' }, 0.5)).toBe(11);
  });
});
