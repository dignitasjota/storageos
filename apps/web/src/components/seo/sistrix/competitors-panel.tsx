'use client';

import { type SeoCompetitorDto, type SeoVisibilitySeriesDto } from '@storageos/shared';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SeoOrigin } from './seo-origin';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatCount, formatDate, formatNumber } from '@/lib/format';
import {
  type SistrixScope,
  useAddCompetitor,
  useRemoveCompetitor,
  useSistrixCompetitors,
  useSistrixDomainKeywordHistory,
  useSistrixDomainKeywords,
  useSistrixVisibility,
  useUpdateCompetitor,
} from '@/lib/seo-advanced/sistrix-hooks';

/**
 * Paleta categórica validada (claro / oscuro), en orden fijo: el color sigue
 * al dominio, nunca a su posición. Más de ocho series no se pintan.
 */
const SERIES_VARS =
  '[--s1:#2a78d6] [--s2:#eb6834] [--s3:#1baf7a] [--s4:#eda100] [--s5:#e87ba4] [--s6:#008300] [--s7:#6250d6] [--s8:#e34948] ' +
  'dark:[--s1:#3987e5] dark:[--s2:#d95926] dark:[--s3:#199e70] dark:[--s4:#c98500] dark:[--s5:#d55181] dark:[--s6:#008300] dark:[--s7:#9085e9] dark:[--s8:#e66767]';
const MAX_SERIES = 8;

function VisibilityChart({ series }: { series: SeoVisibilitySeriesDto[] }) {
  const shown = series.filter((s) => s.points.length > 0).slice(0, MAX_SERIES);
  const data = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>();
    for (const s of shown) {
      for (const p of s.points) {
        const row = rows.get(p.date) ?? { date: p.date };
        row[s.domain] = p.value;
        rows.set(p.date, row);
      }
    }
    return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [shown]);
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay visibilidad descargada. Sincroniza «Visibilidad».
      </p>
    );
  }
  const hidden = series.filter((s) => s.points.length > 0).length - shown.length;
  return (
    <div className={`space-y-1 ${SERIES_VARS}`}>
      <div className="h-64 w-full">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 300, height: 256 }}
        >
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatDate(d)}
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) => formatNumber(v, 2)}
            />
            <Tooltip
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
              labelFormatter={(d) => formatDate(String(d))}
              formatter={(v) => formatNumber(Number(v), 4)}
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                color: 'hsl(var(--popover-foreground))',
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: 'hsl(var(--foreground))' }} />
            {shown.map((s, i) => (
              <Line
                key={s.domain}
                type="monotone"
                dataKey={s.domain}
                name={s.own ? `${s.domain} (tú)` : s.domain}
                stroke={`var(--s${i + 1})`}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        Índice de visibilidad de SISTRIX (semanal, nacional).
        {hidden > 0 ? ` Hay ${hidden} dominio(s) más que no caben en la gráfica.` : ''}
      </p>
    </div>
  );
}

function DomainKeywordsDialog({
  scope,
  domain,
  onClose,
}: {
  scope: SistrixScope;
  domain: string | null;
  onClose: () => void;
}) {
  const list = useSistrixDomainKeywords(scope, domain);
  const [keyword, setKeyword] = useState<string | null>(null);
  const history = useSistrixDomainKeywordHistory(scope, domain, keyword);
  return (
    <Dialog open={!!domain} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">Palabras de {domain}</DialogTitle>
          <DialogDescription>
            Posición y página de cada palabra en la última muestra de SISTRIX
            {list.data?.previousDate
              ? `, comparada con la del ${formatDate(list.data.previousDate)}`
              : ''}
            .
          </DialogDescription>
        </DialogHeader>
        {list.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : list.isError ? (
          <SectionError onRetry={() => void list.refetch()} />
        ) : !list.data || list.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay palabras de este dominio. Sincroniza «Competidores orgánicos» o «Palabras de cada
            dominio» (los dominios pequeños pueden no estar en la muestra de SISTRIX).
          </p>
        ) : (
          <div className="space-y-2">
            {list.data.origin && <SeoOrigin origin={list.data.origin} />}
            <ul className="divide-y text-sm">
              {list.data.items.map((k) => {
                const delta = k.previousPosition !== null ? k.previousPosition - k.position : null;
                return (
                  <li key={k.keyword} className="py-2">
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-3 text-left"
                      onClick={() => setKeyword(keyword === k.keyword ? null : k.keyword)}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{k.keyword}</span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {k.url}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 tabular-nums">
                        {k.position}
                        {delta !== null && delta !== 0 && (
                          <span
                            className={
                              delta > 0
                                ? 'flex items-center text-xs text-emerald-700 dark:text-emerald-400'
                                : 'flex items-center text-xs text-red-700 dark:text-red-400'
                            }
                          >
                            {delta > 0 ? (
                              <ArrowUp className="size-3" aria-hidden />
                            ) : (
                              <ArrowDown className="size-3" aria-hidden />
                            )}
                            {Math.abs(delta)}
                          </span>
                        )}
                      </span>
                    </button>
                    {keyword === k.keyword && (
                      <div className="mt-2 rounded-md bg-muted/50 p-2 text-xs">
                        {history.isLoading ? (
                          'Cargando…'
                        ) : (history.data?.points.length ?? 0) <= 1 ? (
                          'Solo hay una muestra por ahora.'
                        ) : (
                          <ul className="space-y-0.5">
                            {history.data!.points.map((p) => (
                              <li key={p.date} className="flex justify-between gap-2">
                                <span>{formatDate(p.date)}</span>
                                <span className="tabular-nums">Posición {p.position}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Competidores: alta, baja, su visibilidad frente a la tuya y sus palabras. */
export function CompetitorsPanel({
  scope,
  canEdit,
  limit,
}: {
  scope: SistrixScope;
  canEdit: boolean;
  limit: number;
}) {
  const confirm = useConfirm();
  const competitors = useSistrixCompetitors(scope);
  const visibility = useSistrixVisibility(scope);
  const add = useAddCompetitor(scope);
  const update = useUpdateCompetitor(scope);
  const remove = useRemoveCompetitor(scope);
  const [domain, setDomain] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await add.mutateAsync({ domain });
      setDomain('');
      toast.success('Competidor añadido');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const toggle = async (c: SeoCompetitorDto) => {
    try {
      await update.mutateAsync({ id: c.id, isActive: !c.isActive });
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const del = async (c: SeoCompetitorDto) => {
    const yes = await confirm({
      title: `¿Quitar ${c.domain}?`,
      description: 'Lo descargado de este dominio se conserva por si lo vuelves a añadir.',
      confirmLabel: 'Quitar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(c.id);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const active = competitors.data?.filter((c) => c.isActive) ?? [];
  const suggested = competitors.data?.filter((c) => !c.isActive) ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Visibilidad: tú frente a tus competidores</h3>
        {visibility.isError ? (
          <SectionError onRetry={() => void visibility.refetch()} />
        ) : visibility.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <VisibilityChart series={visibility.data ?? []} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Competidores que sigues</h3>
          <span className="text-xs text-muted-foreground">
            {active.length} de {limit}
          </span>
        </div>
        {canEdit && (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="competidor.es"
              aria-label="Dominio del competidor"
              className="sm:max-w-xs"
            />
            <Button type="submit" size="sm" disabled={add.isPending || domain.trim().length < 3}>
              <Plus className="mr-1 size-4" aria-hidden /> Añadir
            </Button>
          </form>
        )}
        {competitors.isError ? (
          <SectionError onRetry={() => void competitors.refetch()} />
        ) : competitors.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no sigues a ningún competidor.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {active.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    className="break-all text-left font-medium hover:underline"
                    onClick={() => setViewing(c.domain)}
                  >
                    {c.name ? `${c.name} · ${c.domain}` : c.domain}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <span>
                      Visibilidad {c.visibility ? formatNumber(c.visibility.value, 4) : '—'}
                    </span>
                    {c.keywordCount !== null && <span>{formatCount(c.keywordCount)} palabras</span>}
                    {c.visibility && <SeoOrigin origin={c.visibility} />}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="sm" onClick={() => setViewing(c.domain)}>
                    Sus palabras
                  </Button>
                  {canEdit && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => void toggle(c)}>
                        Dejar de seguir
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Quitar ${c.domain}`}
                        onClick={() => void del(c)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {suggested.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Sugeridos por SISTRIX o sin seguir</h3>
          <p className="text-xs text-muted-foreground">
            Dominios que compiten por tus búsquedas. Muchos son portales: sigue solo los que sean
            competencia de verdad.
          </p>
          <ul className="flex flex-wrap gap-2">
            {suggested.map((c) => (
              <li key={c.id}>
                <Badge variant="outline" className="gap-1 py-1">
                  <span className="break-all">{c.domain}</span>
                  {c.source === 'discovered' && (
                    <span className="text-muted-foreground">· SISTRIX</span>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="ml-1 text-primary hover:underline"
                      onClick={() => void toggle(c)}
                    >
                      Seguir
                    </button>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DomainKeywordsDialog scope={scope} domain={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
