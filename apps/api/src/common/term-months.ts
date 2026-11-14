/** Meses del plazo de un contrato (mínimo 1), para prorrogarlo por lo mismo. */
export function termMonths(start: Date, end: Date): number {
  // El día siguiente al fin cierra el plazo (1 ene → 31 dic = 12 meses).
  const e = new Date(end.getTime() + 86_400_000);
  const months =
    (e.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (e.getUTCMonth() - start.getUTCMonth()) -
    (e.getUTCDate() < start.getUTCDate() ? 1 : 0);
  return Math.min(120, Math.max(1, months));
}
