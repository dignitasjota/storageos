import type { BenchmarkMetricDto } from '@storageos/shared';

/**
 * Percentil por interpolación lineal simple sobre un array ORDENADO ascendente.
 * `p` en [0, 100]. Devuelve 0 si el array está vacío.
 */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0] ?? 0;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sortedAsc[lo] ?? 0;
  if (lo === hi) return loVal;
  const hiVal = sortedAsc[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

/** Mediana (p50) de un array ORDENADO ascendente. */
export function median(sortedAsc: number[]): number {
  return percentile(sortedAsc, 50);
}

/**
 * Percentil del valor `value` dentro del vector: % de elementos ESTRICTAMENTE
 * por debajo de `value`. Devuelve 0 si el vector está vacío.
 */
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0;
  let below = 0;
  for (const v of values) if (v < value) below += 1;
  return (below / values.length) * 100;
}

/**
 * Construye el DTO de una métrica: ordena el vector, calcula p25/mediana/p75 y
 * el percentil del propio tenant (`mine`). Redondea a 2 decimales para evitar
 * ruido de coma flotante en la respuesta.
 */
export function computeMetric(values: number[], mine: number): BenchmarkMetricDto {
  const sorted = [...values].sort((a, b) => a - b);
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    median: round2(percentile(sorted, 50)),
    p25: round2(percentile(sorted, 25)),
    p75: round2(percentile(sorted, 75)),
    mine: round2(mine),
    myPercentile: Math.round(percentileRank(sorted, mine)),
  };
}
