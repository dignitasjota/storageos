'use client';

import {
  SEO_PANEL_PERIODS,
  SEO_PANEL_PERIOD_LABELS,
  SEO_DOMAIN_ROLE_LABELS,
  shiftDate,
  type SeoChangeDto,
  type SeoDashboardDto,
  type SeoDomainRole,
  type SeoPanelPeriod,
  type SeoTotalsDto,
} from '@storageos/shared';
import { Info, Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { SeoChange } from './seo-change';
import {
  SeoTrendChart,
  SeoShareList,
  DEVICE_LABELS,
  SEARCH_TYPE_LABELS,
  countryLabel,
} from './seo-charts';
import { SeoTablesCard } from './seo-tables-card';

import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import {
  useSeoDashboard,
  type SeoPanelClient,
  type SeoPanelParams,
} from '@/lib/seo-advanced/panel';
import { cn } from '@/lib/utils';

type KpiKey = 'clicks' | 'impressions' | 'ctr' | 'position';

const KPI: Record<
  KpiKey,
  {
    label: string;
    value: (t: SeoTotalsDto) => string;
    change: (c: SeoChangeDto) => [number | null, string];
  }
> = {
  clicks: {
    label: 'Clics',
    value: (t) => formatCount(t.clicks),
    change: (c) => [c.clicksPct, ' %'],
  },
  impressions: {
    label: 'Impresiones',
    value: (t) => formatCount(t.impressions),
    change: (c) => [c.impressionsPct, ' %'],
  },
  ctr: {
    label: 'CTR (clics por impresión)',
    value: (t) => (t.ctr == null ? '—' : formatPct(t.ctr * 100)),
    change: (c) => [c.ctrDiff == null ? null : Math.round(c.ctrDiff * 1000) / 10, ' puntos'],
  },
  position: {
    label: 'Posición media',
    value: (t) => (t.position == null ? '—' : formatNumber(t.position, 1)),
    // Positivo = sube puestos (mejor).
    change: (c) => [c.positionDiff, ' puestos'],
  },
};

function Kpi({ k, d }: { k: KpiKey; d: SeoDashboardDto }) {
  const spec = KPI[k];
  const [prev, prevSuffix] = d.previousChange ? spec.change(d.previousChange) : [null, ''];
  const [yoy, yoySuffix] = d.yearAgoChange ? spec.change(d.yearAgoChange) : [null, ''];
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{spec.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{spec.value(d.current)}</p>
      <div className="mt-1 space-y-0.5 text-xs">
        <p className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">vs anterior:</span>
          {d.previous ? (
            <SeoChange value={prev} suffix={prevSuffix} />
          ) : (
            <span className="text-muted-foreground">sin datos</span>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">vs hace un año:</span>
          {d.yearAgo ? (
            <SeoChange value={yoy} suffix={yoySuffix} />
          ) : (
            <span className="text-muted-foreground">sin datos</span>
          )}
        </p>
      </div>
    </div>
  );
}

function PeriodBar({
  params,
  onChange,
  lastDate,
}: {
  params: SeoPanelParams;
  onChange: (p: SeoPanelParams) => void;
  lastDate: string | null;
}) {
  const pick = (period: SeoPanelPeriod) => {
    if (period !== 'custom') return onChange({ ...params, period });
    // Al elegirlo, los últimos 28 días como punto de partida.
    const to = params.to ?? lastDate ?? undefined;
    const from = params.from ?? (to ? shiftDate(to, -27) : undefined);
    onChange({ ...params, period, to, from });
  };
  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap gap-1 rounded-lg border p-0.5"
        role="group"
        aria-label="Periodo"
      >
        {SEO_PANEL_PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => pick(p)}
            aria-pressed={params.period === p}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              params.period === p ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {SEO_PANEL_PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
      {params.period === 'custom' && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="space-y-1">
            <Label className="text-xs">Desde</Label>
            <DateSelect
              value={params.from}
              years={4}
              {...(lastDate ? { max: lastDate } : {})}
              onChange={(v) => onChange({ ...params, from: v })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Hasta</Label>
            <DateSelect
              value={params.to}
              years={4}
              {...(lastDate ? { max: lastDate } : {})}
              onChange={(v) => onChange({ ...params, to: v })}
            />
          </div>
          {(!params.from || !params.to) && (
            <p className="pb-2 text-xs text-muted-foreground">Elige las dos fechas.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Panel de SEO Avanzado de un proyecto: periodo y dominio, indicadores con su
 * variación (frente al periodo anterior y al mismo del año pasado), evolución
 * diaria, reparto por dispositivo, país y tipo de búsqueda, y las tablas de
 * búsquedas y páginas. El mismo en el panel del tenant y en el del admin.
 */
export function SeoPanel({
  client,
  domains,
}: {
  client: SeoPanelClient;
  domains: { id: string; domain: string; role: SeoDomainRole }[];
}) {
  const [params, setParams] = useState<SeoPanelParams>({ period: '28d', domainId: null });
  const dashboard = useSeoDashboard(client, params);
  const d = dashboard.data;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between lg:space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2">
              Rendimiento en Google
              <Badge variant="outline" className="font-normal">
                Datos de Google Search Console
              </Badge>
              {d && d.importedDays > 0 && (
                <Badge variant="secondary" className="font-normal">
                  Importado: {formatCount(d.importedDays)} {d.importedDays === 1 ? 'día' : 'días'}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {d?.lastDate
                ? `Del ${formatDate(d.from)} al ${formatDate(d.to)}${d.domain ? ` · ${d.domain}` : ''}. Últimos datos de Google: ${formatDate(d.lastDate)}.`
                : 'Los totales que da Google para cada dominio, sin sumar dominios entre sí.'}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col gap-2 lg:items-end">
            {domains.length > 1 && (
              <Select
                value={params.domainId ?? d?.domainId ?? domains[0]!.id}
                onValueChange={(v) => setParams({ ...params, domainId: v })}
              >
                <SelectTrigger className="h-8 w-full sm:w-[260px]" aria-label="Dominio">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.domain} ({SEO_DOMAIN_ROLE_LABELS[x.role].toLowerCase()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <PeriodBar params={params} onChange={setParams} lastDate={d?.lastDate ?? null} />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {dashboard.isError ? (
            <SectionError onRetry={() => void dashboard.refetch()} />
          ) : params.period === 'custom' && (!params.from || !params.to) ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Elige el principio y el final del periodo.
            </p>
          ) : dashboard.isLoading || !d ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !d.lastDate ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Aún no hay datos de Google de este dominio. Aparecerán cuando termine la primera
              descarga (o importa un Excel de Search Console).
            </p>
          ) : (
            <DashboardBody d={d} />
          )}
        </CardContent>
      </Card>

      {d?.lastDate && <SeoTablesCard client={client} params={params} />}
    </div>
  );
}

function DashboardBody({ d }: { d: SeoDashboardDto }) {
  const compare = d.previous !== null;
  return (
    <>
      {d.delayed && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Google lleva {d.dataDelayDays} días sin dar datos nuevos de este dominio (lo normal son 2
          o 3). Comprueba el acceso de la cuenta en Search Console.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(['clicks', 'impressions', 'ctr', 'position'] as const).map((k) => (
          <Kpi key={k} k={k} d={d} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {d.previous
          ? `Comparado con el ${formatDate(d.previousFrom)} – ${formatDate(d.previousTo)}`
          : 'No hay datos de todo el periodo anterior: no se compara'}
        {' · '}
        {d.yearAgo
          ? `y con el ${formatDate(d.yearAgoFrom)} – ${formatDate(d.yearAgoTo)}.`
          : 'no hay datos del mismo periodo del año pasado (importa los Excel de Search Console para tenerlos).'}
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        <SeoTrendChart title="Clics" metric="clicks" days={d.daily} compare={compare} />
        <SeoTrendChart title="Impresiones" metric="impressions" days={d.daily} compare={compare} />
        <SeoTrendChart title="CTR (%)" metric="ctr" days={d.daily} compare={false} />
        <SeoTrendChart
          title="Posición media (arriba es mejor)"
          metric="position"
          days={d.daily}
          compare={false}
        />
      </div>
      {d.importedDays > 0 && (
        <p className="text-xs text-muted-foreground">
          Los días que no tiene la API vienen de los Excel importados (en el detalle de cada punto
          pone «importado»).
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <SeoShareList
          title="Por dispositivo"
          rows={d.devices}
          label={(k) => DEVICE_LABELS[k] ?? k}
        />
        <SeoShareList
          title="Por país (los 10 primeros)"
          rows={d.countries}
          rest={d.countriesRest}
          label={countryLabel}
        />
        {d.searchTypes.length > 1 && (
          <SeoShareList
            title="Por tipo de búsqueda"
            rows={d.searchTypes}
            label={(k) => SEARCH_TYPE_LABELS[k] ?? k}
          />
        )}
      </div>

      {d.otherDomains.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Tus otros dominios en el mismo periodo</p>
          <ul className="divide-y rounded-lg border text-sm">
            {d.otherDomains.map((o) => (
              <li
                key={o.domainId}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
              >
                <span className="min-w-0 break-all">
                  {o.domain}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({SEO_DOMAIN_ROLE_LABELS[o.role as SeoDomainRole]?.toLowerCase() ?? o.role})
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCount(o.clicks)} clics · {formatCount(o.impressions)} impresiones
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Lo que aún llega por cada dominio, por separado (no se suma al de arriba). Cámbialo en
            el selector de dominio para ver su detalle.
          </p>
        </div>
      )}

      {d.undetailed && d.undetailed.impressions > 0 && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {formatCount(d.undetailed.impressions)} impresiones (
          {formatPct((d.undetailed.impressionsShare ?? 0) * 100, 0)}) y{' '}
          {formatCount(d.undetailed.clicks)} clics vienen de búsquedas que Google no detalla, por
          poco frecuentes o por privacidad. Cuentan en los totales, pero no aparecen en la lista de
          búsquedas.
        </p>
      )}
    </>
  );
}
