/**
 * Aritmetica de dinero sin drift de coma flotante.
 *
 * Los importes viven en Postgres como `Decimal(12,2)` pero el codigo los
 * maneja como `number` (via `Number()` sobre el Decimal de Prisma). Sumar
 * y comparar floats directamente obliga a epsilons (`>= total - 0.001`),
 * que es fragil. Estos helpers redondean a centimos ENTEROS antes de
 * operar: `0.1 + 0.2` son 30 centimos exactos, y las comparaciones son
 * exactas sin epsilon.
 *
 * Entrada: `number` o cualquier cosa convertible (el `Decimal` de Prisma
 * pasa por `Number()`). Salida: `number` con 2 decimales exactos, listo
 * para escribirse en una columna `Decimal(12,2)`.
 */

type MoneyLike = number | string | { toString(): string };

/** Importe en euros → centimos enteros (redondeo half-away-from-zero de Math.round). */
export function toCents(amount: MoneyLike): number {
  return Math.round(Number(amount) * 100);
}

/** Suma exacta en centimos, devuelta en euros con 2 decimales. */
export function addAmounts(a: MoneyLike, b: MoneyLike): number {
  return (toCents(a) + toCents(b)) / 100;
}

/** Resta exacta (`a - b`) en centimos, devuelta en euros con 2 decimales. */
export function subtractAmounts(a: MoneyLike, b: MoneyLike): number {
  return (toCents(a) - toCents(b)) / 100;
}

/** `a >= b` con precision exacta de centimo (sin epsilon). */
export function isAtLeast(a: MoneyLike, b: MoneyLike): boolean {
  return toCents(a) >= toCents(b);
}

/** `a > b` con precision exacta de centimo (sin epsilon). */
export function isGreaterThan(a: MoneyLike, b: MoneyLike): boolean {
  return toCents(a) > toCents(b);
}
