'use client';

import {
  SEO_OPPORTUNITY_OPEN_STATUSES,
  SEO_OPPORTUNITY_TYPES,
  SEO_OPPORTUNITY_TYPE_LABELS,
  type SeoOpportunitySort,
  type SeoOpportunityStatus,
  type SeoOpportunityType,
  type SeoProjectDomainDto,
  type SeoScoredOpportunityDto,
} from '@storageos/shared';
import { Check, Download, Loader2, Play, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import {
  OpportunityFigures,
  OpportunityOrigins,
  OpportunityScore,
  OpportunityStatusBadge,
  OpportunityTypeBadge,
} from './opportunity-bits';
import { OpportunityDetailSheet } from './opportunity-detail-sheet';
import { OpportunitySettingsDialog } from './opportunity-settings-dialog';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatCount, formatDateTime } from '@/lib/format';
import {
  type OpportunityFilters,
  type OpportunityScope,
  opportunitiesCsv,
  useOpportunityList,
  useOpportunitySummary,
  useRecalculateOpportunities,
  useUpdateOpportunity,
} from '@/lib/seo-advanced/opportunity-hooks';
import { cn } from '@/lib/utils';

const ALL = 'all';
/** Opciones de estado del filtro. */
const STATUS_OPTIONS: { value: string; label: string; statuses: SeoOpportunityStatus[] }[] = [
  { value: 'open', label: 'Pendientes', statuses: SEO_OPPORTUNITY_OPEN_STATUSES },
  { value: 'new', label: 'Nuevas', statuses: ['new'] },
  { value: 'in_progress', label: 'En curso', statuses: ['in_progress'] },
  { value: 'done', label: 'Hechas', statuses: ['done'] },
  { value: 'dismissed', label: 'Descartadas', statuses: ['dismissed'] },
  {
    value: ALL,
    label: 'Todas',
    statuses: ['new', 'seen', 'in_progress', 'done', 'dismissed'],
  },
];
const SCORE_OPTIONS = [
  { value: ALL, label: 'Cualquier puntuación' },
  { value: '30', label: '30 o más' },
  { value: '50', label: '50 o más' },
  { value: '70', label: '70 o más' },
];
const SORT_LABELS: Record<SeoOpportunitySort, string> = {
  score: 'Mejor puntuación',
  detected: 'Más recientes',
  updated: 'Cambiadas hace poco',
};

/**
 * Oportunidades del proyecto: las del motor propio (Search Console, tus
 * palabras y la competencia) y las de SISTRIX, en una sola lista con su
 * puntuación, su origen y su fecha. Lo usan la ficha del proyecto del panel
 * admin y la página de SEO Avanzado del tenant.
 */
export function SeoOpportunitiesCard({
  scope,
  canEdit,
  domains = [],
}: {
  scope: OpportunityScope;
  /** Puede cambiar estados, recalcular y tocar pesos y umbrales. */
  canEdit: boolean;
  domains?: Pick<SeoProjectDomainDto, 'id' | 'domain' | 'role'>[];
}) {
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<OpportunityFilters>({
    types: [],
    statuses: SEO_OPPORTUNITY_OPEN_STATUSES,
    minScore: null,
    search: '',
    domainId: null,
    sort: 'score',
  });
  const [statusOption, setStatusOption] = useState('open');
  const [open, setOpen] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dismissing, setDismissing] = useState<{ id: string; query: string } | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, search: input })), 300);
    return () => clearTimeout(t);
  }, [input]);

  const summary = useOpportunitySummary(scope);
  const list = useOpportunityList(scope, filters);
  const recalc = useRecalculateOpportunities(scope);
  const update = useUpdateOpportunity(scope);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const calculatedAt = summary.data?.calculatedAt ?? null;

  const setStatus = async (o: SeoScoredOpportunityDto, status: SeoOpportunityStatus) => {
    try {
      await update.mutateAsync({ id: o.id, input: { status } });
      toast.success(status === 'done' ? 'Marcada como hecha' : 'Marcada en curso');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const runRecalc = async () => {
    try {
      const r = await recalc.mutateAsync();
      toast.success(
        `Recalculadas: ${formatCount(r.detected)} oportunidades (${formatCount(r.created)} nuevas${r.returned ? `, ${formatCount(r.returned)} han vuelto` : ''}).`,
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const blob = await opportunitiesCsv(scope, filters);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'oportunidades.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const ownDomains = domains.filter((d) => d.role !== 'redirect');
  const typeValue = filters.types.length === 1 ? filters.types[0]! : ALL;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">Oportunidades</CardTitle>
            <CardDescription>
              Búsquedas donde un empujón puede traerte visitas, puntuadas de 0 a 100 con el motivo y
              qué hacer. Los datos de Google son reales; los de SISTRIX, estimaciones.
            </CardDescription>
            <p className="text-xs text-muted-foreground">
              {calculatedAt
                ? `Calculadas el ${formatDateTime(calculatedAt)}. Se recalculan solas tras cada descarga.`
                : 'Aún no se han calculado: se calculan solas tras la próxima descarga de Search Console.'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runRecalc()}
                disabled={recalc.isPending}
              >
                {recalc.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="mr-1 size-4" aria-hidden />
                )}
                Recalcular ahora
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void downloadCsv()}
              disabled={downloading || rows.length === 0}
            >
              {downloading ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-1 size-4" aria-hidden />
              )}
              CSV
            </Button>
            {canEdit && (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Pesos y umbrales"
                title="Pesos y umbrales"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {summary.isError ? (
          <SectionError onRetry={() => void summary.refetch()} />
        ) : (
          summary.data && (
            <Summary
              summary={summary.data}
              activeType={typeValue}
              onType={(t) => setFilters((f) => ({ ...f, types: t === ALL ? [] : [t] }))}
              onOpen={setOpen}
            />
          )
        )}

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search
              className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Buscar búsqueda"
              aria-label="Buscar búsqueda"
              className="pl-8"
            />
          </div>
          <Select
            value={typeValue}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, types: v === ALL ? [] : [v as SeoOpportunityType] }))
            }
          >
            <SelectTrigger aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los tipos</SelectItem>
              {SEO_OPPORTUNITY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {SEO_OPPORTUNITY_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusOption}
            onValueChange={(v) => {
              setStatusOption(v);
              const opt = STATUS_OPTIONS.find((o) => o.value === v)!;
              setFilters((f) => ({ ...f, statuses: opt.statuses }));
            }}
          >
            <SelectTrigger aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.minScore === null ? ALL : String(filters.minScore)}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, minScore: v === ALL ? null : Number(v) }))
            }
          >
            <SelectTrigger aria-label="Puntuación mínima">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCORE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.sort}
            onValueChange={(v) => setFilters((f) => ({ ...f, sort: v as SeoOpportunitySort }))}
          >
            <SelectTrigger aria-label="Orden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SeoOpportunitySort[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ownDomains.length > 1 && (
            <Select
              value={filters.domainId ?? ALL}
              onValueChange={(v) => setFilters((f) => ({ ...f, domainId: v === ALL ? null : v }))}
            >
              <SelectTrigger aria-label="Dominio" className="sm:col-span-2 lg:col-span-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los dominios</SelectItem>
                {ownDomains.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {list.isError ? (
          <SectionError onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {calculatedAt
              ? 'No hay oportunidades con estos filtros.'
              : 'Todavía no hay oportunidades calculadas.'}
          </p>
        ) : (
          <>
            <ul className="divide-y rounded-md border">
              {rows.map((o) => (
                <li key={o.id} className="flex gap-3 p-3">
                  <OpportunityScore score={o.score} className="pt-0.5" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <OpportunityTypeBadge type={o.type} />
                      <OpportunityStatusBadge status={o.status} returned={!!o.returnedAt} />
                      {o.assignedToName && (
                        <span className="text-xs text-muted-foreground">· {o.assignedToName}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpen(o.id)}
                      className="block max-w-full break-words text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                      {o.query}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      <OpportunityFigures o={o} />
                    </p>
                    <p className="line-clamp-2 text-sm">{o.action}</p>
                    <OpportunityOrigins o={o} />
                    {canEdit && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {o.status !== 'in_progress' && o.status !== 'done' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            disabled={update.isPending}
                            onClick={() => void setStatus(o, 'in_progress')}
                          >
                            <Play className="mr-1 size-3.5" aria-hidden /> En curso
                          </Button>
                        )}
                        {o.status !== 'done' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            disabled={update.isPending}
                            onClick={() => void setStatus(o, 'done')}
                          >
                            <Check className="mr-1 size-3.5" aria-hidden /> Hecha
                          </Button>
                        )}
                        {o.status !== 'dismissed' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8"
                            onClick={() => setDismissing({ id: o.id, query: o.query })}
                          >
                            <X className="mr-1 size-3.5" aria-hidden /> Descartar
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {formatCount(rows.length)} de {formatCount(total)}
              </span>
              {list.hasNextPage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && (
                    <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                  )}
                  Cargar más
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <OpportunityDetailSheet
        scope={scope}
        id={open}
        canEdit={canEdit}
        onClose={() => setOpen(null)}
        onDismiss={(id, query) => setDismissing({ id, query })}
      />
      {canEdit && (
        <>
          <OpportunitySettingsDialog
            scope={scope}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
          <DismissDialog
            target={dismissing}
            onClose={() => setDismissing(null)}
            onConfirm={async (reason) => {
              if (!dismissing) return;
              try {
                await update.mutateAsync({
                  id: dismissing.id,
                  input: { status: 'dismissed', dismissReason: reason },
                });
                toast.success('Descartada. Volverá si su puntuación sube mucho.');
                setDismissing(null);
              } catch (err) {
                toast.error(seoErrorMessage(err));
              }
            }}
            pending={update.isPending}
          />
        </>
      )}
    </Card>
  );
}

function Summary({
  summary,
  activeType,
  onType,
  onOpen,
}: {
  summary: NonNullable<ReturnType<typeof useOpportunitySummary>['data']>;
  activeType: string;
  onType: (t: SeoOpportunityType | typeof ALL) => void;
  onOpen: (id: string) => void;
}) {
  const pending = SEO_OPPORTUNITY_TYPES.reduce((s, t) => s + summary.byType[t], 0);
  const types = SEO_OPPORTUNITY_TYPES.filter((t) => summary.byType[t] > 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-semibold tabular-nums">{formatCount(pending)}</span> pendientes
        </span>
        <span className="text-muted-foreground">
          {formatCount(summary.byStatus.in_progress)} en curso ·{' '}
          {formatCount(summary.byStatus.done)} hechas · {formatCount(summary.byStatus.dismissed)}{' '}
          descartadas
        </span>
        {summary.returned > 0 && (
          <span className="text-amber-800 dark:text-amber-300">
            {formatCount(summary.returned)} han vuelto tras descartarlas
          </span>
        )}
      </div>
      {types.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Pendientes por tipo">
          {types.map((t) => (
            <Button
              key={t}
              type="button"
              size="sm"
              variant={activeType === t ? 'secondary' : 'outline'}
              aria-pressed={activeType === t}
              className="h-8 font-normal"
              onClick={() => onType(activeType === t ? ALL : t)}
            >
              {SEO_OPPORTUNITY_TYPE_LABELS[t]}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {formatCount(summary.byType[t])}
              </span>
            </Button>
          ))}
        </div>
      )}
      {summary.top.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Las 5 mejores</p>
          <ol className="space-y-1">
            {summary.top.map((o, i) => (
              <li key={o.id} className="flex items-center gap-2 text-sm">
                <span className="w-4 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
                <span
                  className={cn(
                    'w-8 shrink-0 text-right font-semibold tabular-nums',
                    o.score >= 70 && 'text-emerald-700 dark:text-emerald-400',
                  )}
                >
                  {o.score}
                </span>
                <button
                  type="button"
                  onClick={() => onOpen(o.id)}
                  className="min-w-0 truncate text-left hover:underline"
                  title={o.query}
                >
                  {o.query}
                </button>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {SEO_OPPORTUNITY_TYPE_LABELS[o.type]}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function DismissDialog({
  target,
  onClose,
  onConfirm,
  pending,
}: {
  target: { id: string; query: string } | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  pending: boolean;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (target) setReason('');
  }, [target]);
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">Descartar «{target?.query}»</DialogTitle>
          <DialogDescription>
            No volverá a salir como pendiente salvo que su puntuación suba mucho (entonces vuelve
            como nueva y con aviso).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="dismiss-reason">Motivo</Label>
          <Textarea
            id="dismiss-reason"
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Por ejemplo: no ofrecemos ese servicio"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onConfirm(reason.trim())}
            disabled={!valid || pending}
          >
            {pending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Descartar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
