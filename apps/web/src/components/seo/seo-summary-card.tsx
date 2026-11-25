'use client';

import { SEO_PERIODS, type SeoSummaryDto, type SeoTotalsDto } from '@storageos/shared';
import { ArrowDown, ArrowUp, Info, Loader2, TriangleAlert } from 'lucide-react';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';

const DEVICE_LABELS: Record<string, string> = {
  MOBILE: 'Móvil',
  DESKTOP: 'Ordenador',
  TABLET: 'Tableta',
};

/** Variación frente al periodo anterior, en verde si mejora. */
function Change({
  value,
  suffix,
  decimals = 1,
  invert = false,
}: {
  value: number | null | undefined;
  suffix: string;
  decimals?: number;
  invert?: boolean;
}) {
  if (value == null) return <span className="text-xs text-muted-foreground">Sin comparar</span>;
  if (value === 0) return <span className="text-xs text-muted-foreground">Igual que antes</span>;
  const better = invert ? value < 0 : value > 0;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        better ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {formatNumber(Math.abs(value), decimals)}
      {suffix}
    </span>
  );
}

function Kpi({ label, value, change }: { label: string; value: string; change: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <div className="mt-1">{change}</div>
    </div>
  );
}

const ctrText = (t: SeoTotalsDto) => (t.ctr == null ? '—' : formatPct(t.ctr * 100));
const positionText = (t: SeoTotalsDto) => (t.position == null ? '—' : formatNumber(t.position, 1));

/**
 * Resumen de un dominio: clics, impresiones, CTR y posición media del periodo
 * frente al anterior, con el reparto por dispositivo. Los totales son los de
 * Google (cruce del sitio), no la suma de las búsquedas.
 */
export function SeoSummaryCard({
  summary,
  isLoading,
  isError,
  onRetry,
  days,
  onDaysChange,
  domains = [],
  domainId,
  onDomainChange,
}: {
  summary: SeoSummaryDto | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  days: number;
  onDaysChange: (days: number) => void;
  /** Con varios dominios, se elige cuál ver (cada uno con sus datos, sin sumar). */
  domains?: { id: string; domain: string }[];
  domainId?: string | null;
  onDomainChange?: (domainId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Resumen
            <Badge variant="outline" className="font-normal">
              Datos de Google Search Console
            </Badge>
          </CardTitle>
          <CardDescription>
            {summary?.lastDate
              ? `Del ${formatDate(summary.from)} al ${formatDate(summary.to)}${summary.domain ? ` · ${summary.domain}` : ''}, frente a los ${days} días anteriores.`
              : 'Los totales que da Google para tu web en el periodo.'}
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {domains.length > 1 && onDomainChange && (
            <Select
              value={domainId ?? summary?.domainId ?? domains[0]!.id}
              onValueChange={onDomainChange}
            >
              <SelectTrigger className="h-8 w-[200px]" aria-label="Dominio">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {domains.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex gap-1 rounded-lg border p-0.5" role="group" aria-label="Periodo">
            {SEO_PERIODS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDaysChange(d)}
                aria-pressed={days === d}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  days === d ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                {d} días
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? (
          <SectionError onRetry={onRetry} />
        ) : isLoading || !summary ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !summary.lastDate ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aún no hay datos de Google. Aparecerán cuando termine la primera descarga.
          </p>
        ) : (
          <>
            {summary.delayed && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                Google lleva varios días sin dar datos nuevos de este dominio. Comprueba el acceso
                de la cuenta en Search Console.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label="Clics"
                value={formatCount(summary.current.clicks)}
                change={<Change value={summary.change?.clicksPct} suffix=" %" />}
              />
              <Kpi
                label="Impresiones"
                value={formatCount(summary.current.impressions)}
                change={<Change value={summary.change?.impressionsPct} suffix=" %" />}
              />
              <Kpi
                label="CTR (clics por impresión)"
                value={ctrText(summary.current)}
                change={
                  <Change
                    value={summary.change?.ctrDiff == null ? null : summary.change.ctrDiff * 100}
                    suffix=" puntos"
                  />
                }
              />
              <Kpi
                label="Posición media"
                value={positionText(summary.current)}
                change={<Change value={summary.change?.positionDiff} suffix=" puestos" />}
              />
            </div>
            {summary.devices.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Por dispositivo</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {summary.devices.map((d) => (
                    <div key={d.device} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{DEVICE_LABELS[d.device] ?? d.device}</span>
                        <span className="text-xs text-muted-foreground">
                          {d.clickShare == null ? '—' : formatPct(d.clickShare * 100, 0)} de los
                          clics
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatCount(d.totals.clicks)} clics · {formatCount(d.totals.impressions)}{' '}
                        impresiones · posición {positionText(d.totals)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.undetailed && summary.undetailed.impressions > 0 && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {formatCount(summary.undetailed.impressions)} impresiones (
                {formatPct((summary.undetailed.impressionsShare ?? 0) * 100, 0)}) y{' '}
                {formatCount(summary.undetailed.clicks)} clics vienen de búsquedas que Google no
                detalla, por poco frecuentes o por privacidad. Cuentan en los totales, pero no
                aparecerán en la lista de búsquedas.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
