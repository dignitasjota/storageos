'use client';

import type { AdminGoalProgressDto } from '@storageos/shared';

/** Barra de progreso de un objetivo del negocio. */
export function GoalBar({
  label,
  progress,
  format,
  hint,
}: {
  label: string;
  progress: AdminGoalProgressDto;
  format: (n: number) => string;
  hint?: string | undefined;
}) {
  const done = progress.pct >= 100;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {format(progress.current)} de {format(progress.target)} ·{' '}
          <span className={done ? 'font-medium text-green-700 dark:text-green-400' : ''}>
            {Math.round(progress.pct)} %
          </span>
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(progress.pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full ${done ? 'bg-green-600' : 'bg-primary'}`}
          style={{ width: `${Math.min(progress.pct, 100)}%` }}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
