'use client';

import { ADMIN_PERIOD_MONTHS } from '@storageos/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Selector común de periodo (3, 6, 12 o 24 meses) de Métricas y Finanzas. */
export function PeriodSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (months: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-44" aria-label="Periodo">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ADMIN_PERIOD_MONTHS.map((m) => (
          <SelectItem key={m} value={String(m)}>
            Últimos {m} meses
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** «+12 % frente a los N meses anteriores» (null si no hay base). */
export function Delta({
  current,
  previous,
  invert = false,
}: {
  current: number;
  previous: number;
  /** Si subir es malo (bajas). */
  invert?: boolean;
}) {
  if (previous === 0) {
    return <span className="text-xs text-muted-foreground">sin datos del periodo anterior</span>;
  }
  const change = ((current - previous) / previous) * 100;
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span
      className={`text-xs ${good ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
    >
      {change >= 0 ? '▲' : '▼'} {Math.abs(Math.round(change))} % frente al periodo anterior
    </span>
  );
}
