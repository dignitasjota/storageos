'use client';

import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';

import { MonthYearSelect, ym } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';

/** Periodo por meses completos: `from` y `to` en YYYY-MM (incluidos). */
export interface Period {
  key: string;
  label: string;
  from: string;
  to: string;
}

function shift(yearMonth: string, months: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const idx = y! * 12 + (m! - 1) + months;
  return ym(Math.floor(idx / 12), (idx % 12) + 1);
}

function length(p: { from: string; to: string }): number {
  const [fy, fm] = p.from.split('-').map(Number);
  const [ty, tm] = p.to.split('-').map(Number);
  return ty! * 12 + tm! - (fy! * 12 + fm!) + 1;
}

export function periodPresets(): Period[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const cur = ym(y, m);
  const qStart = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: 'm12', label: 'Últimos 12 meses', from: shift(cur, -11), to: cur },
    { key: 'm6', label: 'Últimos 6 meses', from: shift(cur, -5), to: cur },
    { key: 'm3', label: 'Últimos 3 meses', from: shift(cur, -2), to: cur },
    { key: 'thisYear', label: 'Este año', from: ym(y, 1), to: cur },
    { key: 'lastYear', label: 'Año pasado', from: ym(y - 1, 1), to: ym(y - 1, 12) },
    { key: 'thisQuarter', label: 'Este trimestre', from: ym(y, qStart), to: cur },
  ];
}

/** El periodo de la misma duración justo antes. */
export function previousPeriod(p: { from: string; to: string }): { from: string; to: string } {
  const n = length(p);
  return { from: shift(p.from, -n), to: shift(p.to, -n) };
}

/** Días del periodo (YYYY-MM-DD); el último, como mucho hoy. */
export function periodDays(p: { from: string; to: string }): { from: string; to: string } {
  const [ty, tm] = p.to.split('-').map(Number);
  const lastDay = new Date(ty!, tm!, 0);
  const today = new Date();
  const end = lastDay > today ? today : lastDay;
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: `${p.from}-01`, to: iso(end) };
}

export function periodText(p: Period): string {
  if (p.key !== 'custom') return p.label.toLowerCase();
  const name = (v: string) => {
    const [y, m] = v.split('-').map(Number);
    return new Date(y!, m! - 1, 1).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
  };
  return `${name(p.from)} – ${name(p.to)}`;
}

export function PeriodSelector({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const presets = periodPresets();
  const setCustom = (part: 'from' | 'to', v: string) => {
    const next = { ...value, key: 'custom', label: 'Personalizado', [part]: v };
    // Si los extremos quedan al revés, se ordenan.
    if (next.from > next.to) [next.from, next.to] = [next.to, next.from];
    onChange(next);
  };
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={value.key === p.key ? 'default' : 'outline'}
            onClick={() => onChange(p)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Desde</Label>
          <MonthYearSelect value={value.from} onChange={(v) => setCustom('from', v)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Hasta</Label>
          <MonthYearSelect value={value.to} onChange={(v) => setCustom('to', v)} />
        </div>
      </div>
    </div>
  );
}

/**
 * Variación frente al periodo anterior. `goodWhenUp=false` para lo que conviene
 * que baje (bajas, morosidad).
 */
export function Delta({
  current,
  previous,
  goodWhenUp = true,
  suffix = 'vs periodo anterior',
}: {
  current: number;
  previous: number | null | undefined;
  goodWhenUp?: boolean;
  suffix?: string;
}) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0 && current === 0) {
    return <span className="text-muted-foreground">Igual que el periodo anterior</span>;
  }
  if (previous === 0)
    return <span className="text-muted-foreground">Sin datos el periodo anterior</span>;
  const change = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (change === 0) return <span className="text-muted-foreground">= {suffix}</span>;
  const up = change > 0;
  const good = up === goodWhenUp;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-medium',
        good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {up ? '+' : '−'}
      {Math.abs(change)} %<span className="font-normal text-muted-foreground">&nbsp;{suffix}</span>
    </span>
  );
}

/** Botón «Exportar CSV» para una tabla. */
export function CsvButton({
  filename,
  rows,
  disabled,
}: {
  filename: string;
  rows: () => (string | number)[][];
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={() => downloadCsv(filename, rows())}
    >
      <Download className="mr-1.5 size-4" aria-hidden />
      CSV
    </Button>
  );
}
