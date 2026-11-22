/**
 * Mini gráfica de línea (sin ejes) para la evolución de una cifra en una fila.
 * Con menos de dos puntos no pinta nada.
 */
export function Sparkline({
  values,
  max = 100,
  width = 64,
  height = 20,
  label,
}: {
  values: number[];
  /** Valor que ocupa todo el alto (100 para la salud). */
  max?: number;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2) return null;
  const top = Math.max(max, ...values) || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / top) * height).toFixed(1)}`)
    .join(' ');
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const tone =
    last < first
      ? 'text-red-600 dark:text-red-400'
      : last > first
        ? 'text-green-600 dark:text-green-400'
        : 'text-muted-foreground';
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 overflow-visible ${tone}`}
      role="img"
      aria-label={label ?? `De ${first} a ${last}`}
    >
      <title>{label ?? `De ${first} a ${last}`}</title>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
