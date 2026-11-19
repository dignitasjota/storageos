'use client';

import { Loader2 } from 'lucide-react';

import type { ReactNode } from 'react';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatEur } from '@/lib/format';
import { useOwners } from '@/lib/owners/hooks';

export const eur = (v: number) => formatEur(v);

/** Porcentaje con coma decimal: 0,417 → «41,7 %». */
export function formatPct(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}

/** «2026-05» → «may 26». */
export function shortMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString('es-ES', {
    month: 'short',
    year: '2-digit',
  });
}

/** «2026-05» → «mayo de 2026». */
export function monthName(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
}

/** Mes en curso (AAAA-MM) en la hora del navegador. */
export function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function PanelLoader({ height = 'h-64' }: { height?: string }) {
  return (
    <div className={`flex items-center justify-center ${height}`}>
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Carga, error o contenido de una consulta. Un fallo dice que falló (con
 * «Reintentar»), nunca que no hay datos.
 */
export function QueryState<T>({
  query,
  height,
  children,
}: {
  query: { data: T | undefined; isError: boolean; refetch: () => unknown };
  height?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <SectionError onRetry={() => void query.refetch()} />;
  return <PanelLoader {...(height ? { height } : {})} />;
}

export function KpiCard({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
      </CardContent>
    </Card>
  );
}

/** Los datos de una gráfica, en una tabla plegada (para leerlos sin la gráfica). */
export function ChartData({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground">Ver los datos</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {headers.map((h, i) => (
                <th key={h} className={`py-1.5 font-medium ${i > 0 ? 'text-right' : ''}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                {r.map((cell, j) => (
                  <td key={j} className={`py-1.5 ${j > 0 ? 'text-right tabular-nums' : ''}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Plan Administrador: de quién son las facturas (tu empresa, un propietario o
 * todas). Solo sale si hay propietarios.
 */
export function IssuerSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const owners = useOwners();
  const list = owners.data ?? [];
  if (list.length === 0) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-64" aria-label="Facturas de">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="self">Facturas de tu empresa</SelectItem>
        {list.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            Facturas de {o.legalName}
          </SelectItem>
        ))}
        <SelectItem value="all">Todas las facturas</SelectItem>
      </SelectContent>
    </Select>
  );
}
