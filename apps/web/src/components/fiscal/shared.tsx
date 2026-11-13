'use client';

import { INVOICE_TAX_CATEGORY_LABELS, type InvoiceTaxCategory } from '@storageos/shared';
import { Loader2 } from 'lucide-react';

import { SectionError } from '@/components/dashboard/section-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

export const YEAR = new Date().getFullYear();
export const YEARS = Array.from({ length: 6 }, (_, i) => YEAR - i);

/** Cargando o error de una consulta (antes un fallo se veía como una tabla vacía). */
export function QueryState({
  query,
}: {
  query: { isLoading: boolean; isError: boolean; refetch: () => unknown };
}) {
  if (query.isLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (query.isError) return <SectionError onRetry={() => void query.refetch()} />;
  return null;
}

/** «IVA 21 %», «Exenta (art. 20 LIVA)», «No sujeta». */
export function rateLabel(r: { rate: number; taxCategory: InvoiceTaxCategory }): string {
  return r.taxCategory === 'S1' ? `IVA ${r.rate}%` : INVOICE_TAX_CATEGORY_LABELS[r.taxCategory];
}

export function YearSelect({ value, onChange }: { value: number; onChange: (y: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-24" aria-label="Año">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {YEARS.map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function QuarterSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (q: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-36" aria-label="Trimestre">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[1, 2, 3, 4].map((q) => (
          <SelectItem key={q} value={String(q)}>
            {q}.º trimestre
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** El último trimestre ya terminado (el que toca presentar). */
export function lastEndedQuarter(): { year: number; quarter: number } {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return q === 1
    ? { year: now.getFullYear() - 1, quarter: 4 }
    : { year: now.getFullYear(), quarter: q - 1 };
}
