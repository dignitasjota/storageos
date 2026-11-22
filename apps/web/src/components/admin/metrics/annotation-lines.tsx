'use client';

import { ReferenceLine } from 'recharts';

import { useMetricAnnotations } from '@/lib/admin/metrics-insights-hooks';

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** «2026-11» → «nov 26», la etiqueta de los ejes mensuales. */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${MONTHS_ES[m - 1]} ${String(y % 100).padStart(2, '0')}`;
}

/** Textos de las anotaciones por etiqueta de mes («nov 26»). */
export function useAnnotationsByLabel(): Map<string, string> {
  const q = useMetricAnnotations();
  const map = new Map<string, string>();
  for (const a of q.data ?? []) {
    const label = monthKeyLabel(a.month);
    map.set(label, map.has(label) ? `${map.get(label)} · ${a.text}` : a.text);
  }
  return map;
}

/**
 * Líneas verticales con la anotación de cada mes que sale en el gráfico. Se
 * devuelven como elementos para ponerlos dentro del gráfico de Recharts.
 */
export function annotationLines(byLabel: Map<string, string>, labels: string[]) {
  const shown = new Set(labels);
  return [...byLabel.entries()]
    .filter(([label]) => shown.has(label))
    .map(([label, text]) => (
      <ReferenceLine
        key={`note-${label}`}
        x={label}
        stroke="#7c3aed"
        strokeDasharray="4 3"
        label={{
          value: text.length > 28 ? `${text.slice(0, 27)}…` : text,
          position: 'insideTopLeft',
          fontSize: 10,
          fill: '#7c3aed',
        }}
      />
    ));
}

/** «nov 26» → «2026-11» (inversa de `monthKeyLabel`). */
export function monthLabelKey(label: string): string | undefined {
  const [m, y] = label.split(' ');
  const idx = MONTHS_ES.indexOf(m ?? '');
  if (idx < 0 || !y) return undefined;
  return `20${y.padStart(2, '0')}-${String(idx + 1).padStart(2, '0')}`;
}
