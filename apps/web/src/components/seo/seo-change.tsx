'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';

import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Variación con flecha: verde si mejora. */
export function SeoChange({
  value,
  suffix,
  decimals = 1,
}: {
  value: number | null | undefined;
  suffix: string;
  decimals?: number;
}) {
  if (value == null) return <span className="text-xs text-muted-foreground">Sin comparar</span>;
  if (value === 0) return <span className="text-xs text-muted-foreground">Igual</span>;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        value > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {formatNumber(Math.abs(value), decimals)}
      {suffix}
    </span>
  );
}
