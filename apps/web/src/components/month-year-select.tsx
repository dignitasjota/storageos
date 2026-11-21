'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MONTHS_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

/** "YYYY-MM" a partir de año y mes (1-12). */
export function ym(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Selector de mes + año con los desplegables del proyecto (el `<input
 * type="month">` no abre en Safari y otros). `value` en formato YYYY-MM; emite
 * YYYY-MM al cambiar.
 */
export function MonthYearSelect({
  value,
  onChange,
  years = 6,
  future = false,
  around = false,
  max,
}: {
  value?: string;
  onChange: (v: string) => void;
  /** Último mes elegible (YYYY-MM): los posteriores no se ofrecen. */
  max?: string;
  /** Cuántos años ofrecer (incluido el actual). */
  years?: number;
  /** Hacia delante (fechas futuras) en vez de hacia atrás. */
  future?: boolean;
  /** El año pasado, este y el que viene (p. ej. el periodo de una factura). */
  around?: boolean;
}) {
  const now = new Date();
  const [maxYear, maxMonth] = max ? (max.split('-').map(Number) as [number, number]) : [];
  const yearList = (
    around
      ? [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
      : Array.from({ length: years }, (_, i) =>
          future ? now.getFullYear() + i : now.getFullYear() - i,
        )
  ).filter((y) => maxYear === undefined || y <= maxYear);
  /** Mes y año, sin pasar del máximo. */
  const pick = (y: number, m: number) =>
    onChange(
      maxYear !== undefined && maxMonth !== undefined && y === maxYear && m > maxMonth
        ? ym(y, maxMonth)
        : ym(y, m),
    );
  const parsed = value ? value.split('-').map(Number) : null;
  const curMonth = parsed?.[1];
  const curYear = parsed?.[0];
  const baseYear = curYear ?? now.getFullYear();
  const baseMonth = curMonth ?? now.getMonth() + 1;
  return (
    <div className="flex gap-1.5">
      <Select
        value={curMonth ? String(curMonth) : undefined}
        onValueChange={(v) => pick(baseYear, Number(v))}
      >
        <SelectTrigger className="h-9 w-[130px]" aria-label="Mes">
          <SelectValue placeholder="Mes" />
        </SelectTrigger>
        <SelectContent>
          {MONTHS_ES.map((label, i) => (
            <SelectItem
              key={i}
              value={String(i + 1)}
              disabled={
                maxYear !== undefined &&
                maxMonth !== undefined &&
                baseYear === maxYear &&
                i + 1 > maxMonth
              }
            >
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={curYear ? String(curYear) : undefined}
        onValueChange={(v) => pick(Number(v), baseMonth)}
      >
        <SelectTrigger className="h-9 w-[90px]" aria-label="Año">
          <SelectValue placeholder="Año" />
        </SelectTrigger>
        <SelectContent>
          {yearList.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Selector de fecha (día + mes + año) con los desplegables del proyecto, para
 * no depender de `<input type="date">`. `value` y lo que emite: YYYY-MM-DD.
 */
export function DateSelect({
  value,
  onChange,
  years = 6,
  future = false,
  around = false,
  max,
}: {
  value?: string;
  onChange: (v: string | undefined) => void;
  years?: number;
  future?: boolean;
  /** El año pasado, este y el que viene. */
  around?: boolean;
  /** Último día elegible (YYYY-MM-DD): no se ofrece ninguno posterior. */
  max?: string;
}) {
  const now = new Date();
  const parts = value ? value.split('-').map(Number) : null;
  const year = parts?.[0];
  const month = parts?.[1];
  const day = parts?.[2];
  const daysInMonth = new Date(year ?? now.getFullYear(), month ?? 1, 0).getDate();
  const emit = (y: number, m: number, d: number) => {
    const last = new Date(y, m, 0).getDate();
    const next = `${ym(y, m)}-${String(Math.min(d, last)).padStart(2, '0')}`;
    onChange(max && next > max ? max : next);
  };
  const baseY = year ?? now.getFullYear();
  const baseM = month ?? now.getMonth() + 1;
  const baseD = day ?? 1;
  return (
    <div className="flex gap-1.5">
      <Select
        value={day ? String(day) : undefined}
        onValueChange={(v) => emit(baseY, baseM, Number(v))}
      >
        <SelectTrigger className="h-9 w-[76px]" aria-label="Día">
          <SelectValue placeholder="Día" />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: daysInMonth }, (_, i) => (
            <SelectItem
              key={i + 1}
              value={String(i + 1)}
              disabled={!!max && `${ym(baseY, baseM)}-${String(i + 1).padStart(2, '0')}` > max}
            >
              {i + 1}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <MonthYearSelect
        years={years}
        future={future}
        around={around}
        {...(max ? { max: max.slice(0, 7) } : {})}
        value={year && month ? ym(year, month) : undefined}
        onChange={(v) => {
          const [y, m] = v.split('-').map(Number);
          emit(y!, m!, baseD);
        }}
      />
    </div>
  );
}
