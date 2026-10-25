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
}: {
  value?: string;
  onChange: (v: string) => void;
  /** Cuántos años hacia atrás ofrecer (incluido el actual). */
  years?: number;
}) {
  const now = new Date();
  const yearList = Array.from({ length: years }, (_, i) => now.getFullYear() - i);
  const parsed = value ? value.split('-').map(Number) : null;
  const curMonth = parsed?.[1];
  const curYear = parsed?.[0];
  const baseYear = curYear ?? now.getFullYear();
  const baseMonth = curMonth ?? now.getMonth() + 1;
  return (
    <div className="flex gap-1.5">
      <Select
        value={curMonth ? String(curMonth) : undefined}
        onValueChange={(v) => onChange(ym(baseYear, Number(v)))}
      >
        <SelectTrigger className="h-9 w-[130px]" aria-label="Mes">
          <SelectValue placeholder="Mes" />
        </SelectTrigger>
        <SelectContent>
          {MONTHS_ES.map((label, i) => (
            <SelectItem key={i} value={String(i + 1)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={curYear ? String(curYear) : undefined}
        onValueChange={(v) => onChange(ym(Number(v), baseMonth))}
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
}: {
  value?: string;
  onChange: (v: string | undefined) => void;
  years?: number;
}) {
  const now = new Date();
  const parts = value ? value.split('-').map(Number) : null;
  const year = parts?.[0];
  const month = parts?.[1];
  const day = parts?.[2];
  const daysInMonth = new Date(year ?? now.getFullYear(), month ?? 1, 0).getDate();
  const emit = (y: number, m: number, d: number) => {
    const last = new Date(y, m, 0).getDate();
    onChange(`${ym(y, m)}-${String(Math.min(d, last)).padStart(2, '0')}`);
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
            <SelectItem key={i + 1} value={String(i + 1)}>
              {i + 1}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <MonthYearSelect
        years={years}
        value={year && month ? ym(year, month) : undefined}
        onChange={(v) => {
          const [y, m] = v.split('-').map(Number);
          emit(y!, m!, baseD);
        }}
      />
    </div>
  );
}
