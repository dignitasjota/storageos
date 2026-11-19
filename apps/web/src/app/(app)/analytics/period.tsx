'use client';

import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';

import { MonthYearSelect, ym } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { downloadCsv } from '@/lib/csv';
import { formatEur } from '@/lib/format';
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

/** Con qué se compara: el periodo justo antes o el mismo del año pasado. */
export type CompareMode = 'previous' | 'lastYear';

/** El periodo con el que se compara (de la misma duración). */
export function previousPeriod(
  p: { from: string; to: string },
  mode: CompareMode = 'previous',
): { from: string; to: string } {
  const n = mode === 'lastYear' ? 12 : length(p);
  return { from: shift(p.from, -n), to: shift(p.to, -n) };
}

/** Texto de la comparación: «vs periodo anterior (meses cerrados)». */
export function compareLabel(
  mode: CompareMode,
  opts: { closed?: boolean; sameDay?: boolean } = {},
): string {
  const base = mode === 'lastYear' ? 'vs el mismo periodo del año pasado' : 'vs periodo anterior';
  if (opts.closed) return `${base} (meses cerrados)`;
  if (opts.sameDay) return `${base} hasta el mismo día`;
  return base;
}

/** El periodo sin el mes en curso (que aún no ha terminado). */
export function withoutCurrentMonth<T extends { from: string; to: string }>(p: T): T {
  if (!includesCurrentMonth(p)) return p;
  const now = new Date();
  const to = shift(ym(now.getFullYear(), now.getMonth() + 1), -1);
  return { ...p, to, from: p.from > to ? to : p.from };
}

/** Como mucho se analizan 36 meses: el resto se recorta por el principio. */
export const MAX_PERIOD_MONTHS = 36;

export function periodLength(p: { from: string; to: string }): number {
  return length(p);
}

/** ¿Incluye el mes en curso (que aún no ha terminado)? */
export function includesCurrentMonth(p: { to: string }): boolean {
  const now = new Date();
  return p.to >= ym(now.getFullYear(), now.getMonth() + 1);
}

/**
 * El periodo anterior en días, hasta el mismo día del mes: si el periodo llega
 * a hoy (día 19), el anterior acaba también el día 19 de su último mes. Así se
 * compara lo mismo con lo mismo.
 */
export function previousPeriodDays(
  p: { from: string; to: string },
  mode: CompareMode = 'previous',
): { from: string; to: string } {
  const prev = previousPeriod(p, mode);
  const days = periodDays(p);
  const endDay = Number(days.to.slice(8, 10));
  const [ty, tm] = prev.to.split('-').map(Number);
  const last = new Date(ty!, tm!, 0).getDate();
  return {
    from: `${prev.from}-01`,
    to: `${prev.to}-${String(Math.min(endDay, last)).padStart(2, '0')}`,
  };
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
  compare,
  onCompareChange,
  closedOnly,
  onClosedOnlyChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
  compare?: CompareMode;
  onCompareChange?: (m: CompareMode) => void;
  closedOnly?: boolean;
  onClosedOnlyChange?: (v: boolean) => void;
}) {
  const presets = periodPresets();
  const setCustom = (part: 'from' | 'to', v: string) => {
    const next = { ...value, key: 'custom', label: 'Personalizado', [part]: v };
    // Si los extremos quedan al revés, se ordenan.
    if (next.from > next.to) [next.from, next.to] = [next.to, next.from];
    // Como mucho 36 meses: se recorta el principio (como hace el servidor).
    if (length(next) > MAX_PERIOD_MONTHS) next.from = shift(next.to, -(MAX_PERIOD_MONTHS - 1));
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
        {compare && onCompareChange && (
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="analytics-compare">
              Comparar con
            </Label>
            <select
              id="analytics-compare"
              className="h-9 rounded-md border bg-background px-2 text-base sm:text-sm"
              value={compare}
              onChange={(e) => onCompareChange(e.target.value as CompareMode)}
            >
              <option value="previous">El periodo anterior</option>
              <option value="lastYear">El mismo periodo del año pasado</option>
            </select>
          </div>
        )}
        {onClosedOnlyChange && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={closedOnly === true}
              onCheckedChange={(v) => onClosedOnlyChange(v === true)}
            />
            Sin el mes en curso
          </label>
        )}
        <p className="pb-2 text-xs text-muted-foreground">Como mucho, 36 meses.</p>
      </div>
    </div>
  );
}

/**
 * Variación frente al periodo anterior. `goodWhenUp=false` para lo que conviene
 * que baje (bajas, morosidad). Con `kind='rate'` (ocupación, tasa de bajas), la
 * diferencia va en puntos: de 50 % a 55 % son +5 puntos, no +10 %. Con
 * `kind='count'` y antes 0, se dice cuántos más.
 */
export function Delta({
  current,
  previous,
  goodWhenUp = true,
  suffix = 'vs periodo anterior',
  kind = 'amount',
}: {
  current: number;
  previous: number | null | undefined;
  goodWhenUp?: boolean;
  suffix?: string;
  kind?: 'amount' | 'count' | 'rate';
}) {
  if (previous === null || previous === undefined) return null;
  if (previous === current) return <span className="text-muted-foreground">= {suffix}</span>;

  let text: string;
  if (kind === 'rate') {
    const points = Math.round((current - previous) * 1000) / 10;
    if (points === 0) return <span className="text-muted-foreground">= {suffix}</span>;
    text = `${Math.abs(points).toLocaleString('es-ES')} ${Math.abs(points) === 1 ? 'punto' : 'puntos'}`;
  } else if (previous === 0) {
    // Antes no había nada: no hay porcentaje que valga, se dice lo que hay.
    text =
      kind === 'count'
        ? `${Math.abs(current).toLocaleString('es-ES')} más`
        : `${formatEur(Math.abs(current))} más`;
    // «vs periodo anterior» → «que en el periodo anterior».
    suffix = suffix.replace(/^vs /, 'que en el ');
  } else {
    const change = Math.round(((current - previous) / Math.abs(previous)) * 100);
    if (change === 0) return <span className="text-muted-foreground">= {suffix}</span>;
    text = `${Math.abs(change)} %`;
  }
  const up = current > previous;
  const good = up === goodWhenUp;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'font-medium',
        good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400',
      )}
    >
      <Icon className="mr-0.5 inline size-3.5 align-[-2px]" aria-hidden />
      {previous === 0 && kind !== 'rate' ? '' : up ? '+' : '−'}
      {text}
      <span className="font-normal text-muted-foreground">&nbsp;{suffix}</span>
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
