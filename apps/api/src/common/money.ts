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

/**
 * Redondeo al entero más cercano con los medios lejos del cero (simétrico):
 * 2,5 → 3 y −2,5 → −3. `Math.round` sube hacia +∞ (−2,5 → −2), así que una
 * línea negativa no era la opuesta exacta de la positiva. El pequeño margen
 * absorbe el error de coma flotante (10,05 × 100 = 1004,999…).
 */
export function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
}

/** Importe en euros → centimos enteros (redondeo simétrico). */
export function toCents(amount: MoneyLike): number {
  return roundHalfAway(Number(amount) * 100);
}

/**
 * Importes de una línea de factura en céntimos: base redondeada, cuota sobre
 * la base ya redondeada y total = base + cuota. La línea negativa es siempre
 * la opuesta exacta de la positiva.
 */
export function lineCents(
  quantity: number,
  unitPrice: number,
  taxRate: number,
): { baseCents: number; taxCents: number; totalCents: number } {
  const baseCents = roundHalfAway(quantity * unitPrice * 100);
  const taxCents = roundHalfAway((baseCents * taxRate) / 100);
  return { baseCents, taxCents, totalCents: baseCents + taxCents };
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
