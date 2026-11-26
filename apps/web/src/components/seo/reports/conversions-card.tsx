'use client';

import {
  SEO_CONVERSION_TYPE_LABELS,
  SEO_PANEL_PERIOD_LABELS,
  type SeoConversionsDto,
  type SeoPanelPeriod,
} from '@storageos/shared';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatDateTime, formatEur, formatPct } from '@/lib/format';
import {
  type ReportScope,
  useRecalcConversions,
  useSeoConversions,
  useSetPlatformConversions,
} from '@/lib/seo-advanced/report-hooks';
import { cn } from '@/lib/utils';

const PERIODS: SeoPanelPeriod[] = ['7d', '28d', '90d', '6m', '12m'];
const AUTO = '__auto__';

/** Variación frente al periodo anterior en palabras («+3» / «−1» / «igual»). */
function Delta({ now, before }: { now: number; before: number | null }) {
  if (before === null) return null;
  const diff = now - before;
  return (
    <span
      className={cn(
        'text-xs',
        diff > 0
          ? 'text-green-700 dark:text-green-400'
          : diff < 0
            ? 'text-red-700 dark:text-red-400'
            : 'text-muted-foreground',
      )}
    >
      {diff === 0
        ? 'igual que antes'
        : `${diff > 0 ? '+' : '−'}${formatCount(Math.abs(diff))} frente a antes`}
    </span>
  );
}

const rate = (r: number | null) => (r === null ? '—' : formatPct(r * 100, 1));

/**
 * Qué días usa la tasa: los recuentos llegan hasta hoy, pero los clics solo
 * hasta el último día que ha dado Google (los dos lados, los mismos días).
 */
function RateNote({ d }: { d: SeoConversionsDto }) {
  let text: string | null = null;
  if (!d.rateTo)
    text = 'Aún no hay datos de Google en este periodo: la tasa y los clics salen cuando lleguen.';
  else if (d.rateTo < d.to)
    text = `La tasa y los clics usan hasta el ${formatDate(d.rateTo)}, el último día con datos de Google.`;
  if (d.rateTo && !d.complete) {
    text = `${text ?? ''} Google aún no ha dado todos esos días: sin tasa.`.trim();
  } else if (d.rateTo && !d.comparable) {
    text = `${text ?? ''} Sin días de Google suficientes antes: la tasa no se compara.`.trim();
  }
  return text ? <p className="text-xs text-muted-foreground">{text}</p> : null;
}

/**
 * «Lo que trae Google»: reservas, contactos y lista de espera (en un negocio)
 * o solicitudes y altas (en trasteros.pro) que llegaron desde Google sin
 * anuncios, con la tasa sobre los clics y el reparto por página de entrada.
 */
export function SeoConversionsCard({
  scope,
  canEdit,
  isPlatformProject = false,
}: {
  scope: ReportScope;
  canEdit: boolean;
  /** Proyecto de la plataforma (en el admin): se puede elegir si cuenta lo de trasteros.pro. */
  isPlatformProject?: boolean;
}) {
  const [period, setPeriod] = useState<SeoPanelPeriod>('28d');
  const q = useSeoConversions(scope, period);
  const recalc = useRecalcConversions(scope);
  const platform = useSetPlatformConversions(scope);
  const d = q.data;

  const doRecalc = async () => {
    try {
      await recalc.mutateAsync();
      toast.success('Conversiones recalculadas');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card id="conversiones" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle>Lo que trae Google</CardTitle>
          <CardDescription>
            Lo que llega desde los resultados de Google (sin anuncios), por la página por la que
            entró la gente.
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select value={period} onValueChange={(v) => setPeriod(v as SeoPanelPeriod)}>
            <SelectTrigger className="h-9 w-[150px]" aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {SEO_PANEL_PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doRecalc()}
              disabled={recalc.isPending}
            >
              {recalc.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="mr-1 size-4" aria-hidden />
              )}
              Recalcular
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ConversionsBody
            d={d}
            canEdit={canEdit}
            isPlatformProject={isPlatformProject}
            onPlatformChange={async (v) => {
              try {
                await platform.mutateAsync(v);
                toast.success('Guardado');
              } catch (err) {
                toast.error(seoErrorMessage(err));
              }
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ConversionsBody({
  d,
  canEdit,
  isPlatformProject,
  onPlatformChange,
}: {
  d: SeoConversionsDto;
  canEdit: boolean;
  isPlatformProject: boolean;
  onPlatformChange: (v: boolean | null) => Promise<void>;
}) {
  const platformToggle = isPlatformProject && (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-muted-foreground">
        ¿Este proyecto cuenta las solicitudes y altas de trasteros.pro?
      </span>
      <Select
        value={d.platformConversions === null ? AUTO : d.platformConversions ? 'yes' : 'no'}
        onValueChange={(v) => void onPlatformChange(v === AUTO ? null : v === 'yes')}
        disabled={!canEdit}
      >
        <SelectTrigger className="h-9 w-full sm:w-[230px]" aria-label="Cuenta las de la plataforma">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>Según el dominio</SelectItem>
          <SelectItem value="yes">Sí</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  if (!d.scope) {
    return (
      <div className="space-y-3">
        {platformToggle}
        <p className="text-sm text-muted-foreground">
          Este proyecto no cuenta conversiones: no es la web de un negocio ni la de la plataforma.
        </p>
      </div>
    );
  }

  return (
    <>
      {platformToggle}
      <p className="text-xs text-muted-foreground">
        Del {formatDate(d.from)} al {formatDate(d.to)}, comparado con el{' '}
        {formatDate(d.previousFrom)} al {formatDate(d.previousTo)}.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {d.types.map((t) => (
          <div key={t.type} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{SEO_CONVERSION_TYPE_LABELS[t.type]}</p>
            <p className="text-xl font-semibold tabular-nums">{formatCount(t.count)}</p>
            <Delta now={t.count} before={t.previous} />
            {t.revenue !== null && (
              <p className="text-xs text-muted-foreground">{formatEur(t.revenue)}</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="text-muted-foreground">Clics de Google: </span>
          <span className="font-medium tabular-nums">{formatCount(d.primary.clicks)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Tasa de conversión: </span>
          <span className="font-medium tabular-nums">{rate(d.primary.rate)}</span>
          {d.primary.previousRate !== null && (
            <span className="text-muted-foreground"> (antes {rate(d.primary.previousRate)})</span>
          )}
        </span>
        {d.calculatedAt && (
          <span className="text-xs text-muted-foreground">
            Calculado el {formatDateTime(d.calculatedAt)}
          </span>
        )}
      </div>
      <RateNote d={d} />

      <div>
        <h3 className="text-sm font-medium">Por página de entrada</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Conversiones hasta hoy; clics y tasa con los días de Google
          {d.rateTo && d.rateTo < d.to ? ` (hasta el ${formatDate(d.rateTo)})` : ''}.
        </p>
        {d.pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no ha llegado nada desde Google en este periodo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Página</th>
                  <th className="px-3 py-2 text-right font-medium">Clics</th>
                  <th className="px-3 py-2 text-right font-medium">Conversiones</th>
                  <th className="px-3 py-2 text-right font-medium">Tasa</th>
                </tr>
              </thead>
              <tbody>
                {d.pages.map((p) => (
                  <tr key={p.landing || 'none'} className="border-t">
                    <td className="max-w-[280px] truncate px-3 py-2 font-mono text-xs">
                      {p.landing || (
                        <span className="font-sans text-muted-foreground">No se sabe</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(p.clicks)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCount(p.conversions)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{rate(p.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.queries.length > 0 && (
        <div>
          <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
            Por búsqueda <Badge variant="outline">Estimación</Badge>
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Google no dice qué búsqueda trajo a cada persona: se reparte cada página entre las
            búsquedas que llevan a ella según sus clics.
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {d.queries.map((x) => (
              <li
                key={x.query}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">{x.query}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  ≈ {x.conversions.toLocaleString('es-ES', { maximumFractionDigits: 1 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
