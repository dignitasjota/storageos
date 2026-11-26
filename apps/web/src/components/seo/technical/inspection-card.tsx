'use client';

import {
  SEO_INSPECTION_REASON_LABELS,
  SEO_TECHNICAL_RANGES,
  seoIndexStatusLabel,
  seoInspectionRecent,
  type SeoTechnicalSettings,
  type SeoUrlIndexStatusDto,
  type SeoUrlInspectionDto,
} from '@storageos/shared';
import { History, Info, ListChecks, Loader2, ScanSearch, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { InspectionDetail, InspectUrlButton, SeoIndexStatusBadge } from './inspection-bits';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatCount, formatDateTime } from '@/lib/format';
import {
  type TechnicalScope,
  useInspectionBatch,
  useInspectionHistory,
  useInspectUrl,
  useSeoInspections,
  useUpdateTechnicalSettings,
} from '@/lib/seo-advanced/technical-hooks';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'not_indexed' | 'canonical' | 'pending';

/** Lo que dice Google de la URL de una inspección terminada (para la etiqueta). */
export function statusOf(i: SeoUrlInspectionDto): SeoUrlIndexStatusDto | null {
  if (i.status !== 'done' || !i.inspectedAt) return null;
  return {
    url: i.url,
    inspectedAt: i.inspectedAt,
    indexed: i.indexed,
    verdict: i.verdict,
    reason: i.notIndexedReason,
    label: seoIndexStatusLabel({
      indexed: i.indexed,
      inspectedAt: i.inspectedAt,
      reason: i.notIndexedReason,
    }),
    googleCanonical: i.googleCanonical,
    userCanonical: i.userCanonical,
    canonicalMismatch: i.canonicalMismatch,
    lastCrawlAt: i.lastCrawlAt,
    stale: !seoInspectionRecent(i.inspectedAt),
  };
}

function PendingBadge({ i }: { i: SeoUrlInspectionDto }) {
  if (i.status === 'error') {
    return (
      <Badge variant="outline" className="font-normal text-red-700 dark:text-red-300">
        Error: {i.error ?? 'Google no respondió'}
      </Badge>
    );
  }
  const waiting = i.scheduledFor && Date.parse(i.scheduledFor) > Date.now();
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {waiting ? `Espera a la cuota del ${formatDateTime(i.scheduledFor!)}` : 'En la cola'}
    </Badge>
  );
}

/**
 * «Inspeccionar URL»: lo que dice Google de cada página (si la tiene en su
 * índice, su canónica, el último rastreo), con la cuota del día a la vista.
 * Bajo demanda y, si se activa, en un lote diario acotado.
 */
export function SeoInspectionCard({ scope, canEdit }: { scope: TechnicalScope; canEdit: boolean }) {
  const q = useSeoInspections(scope);
  const inspect = useInspectUrl(scope);
  const batch = useInspectionBatch(scope);
  const [url, setUrl] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [historyUrl, setHistoryUrl] = useState<string | null>(null);
  const [detail, setDetail] = useState<SeoUrlInspectionDto | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    try {
      const r = await inspect.mutateAsync(url.trim());
      if (r.deferred) toast.info(r.message);
      else if (r.inspection.status === 'error') toast.error(r.message);
      else toast.success('Inspección hecha');
      setDetail(r.inspection);
      setUrl('');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const runBatch = async () => {
    try {
      const r = await batch.mutateAsync();
      toast.success(
        r.queued > 0
          ? `${r.queued} URL en la cola: se inspeccionan en unos minutos`
          : 'No hay URL que inspeccionar ahora (o no queda cuota)',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const data = q.data;
  const quota = data?.quota;
  const items = (data?.items ?? []).filter((i) =>
    filter === 'all'
      ? true
      : filter === 'pending'
        ? i.status !== 'done'
        : filter === 'canonical'
          ? i.canonicalMismatch
          : i.status === 'done' && i.indexed === false,
  );
  const usedPct = quota && quota.cap > 0 ? Math.min(100, (quota.used / quota.cap) * 100) : 0;

  return (
    <Card id="inspeccion" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle>Inspeccionar URL</CardTitle>
          <CardDescription>
            Lo que dice Google de cada página: si la tiene en su índice, qué versión considera la
            buena y cuándo la leyó por última vez.
          </CardDescription>
        </div>
        {canEdit && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runBatch()}
              disabled={batch.isPending}
            >
              {batch.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <ListChecks className="mr-1 size-4" aria-hidden />
              )}
              Lanzar el lote ahora
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-1 size-4" aria-hidden /> Ajustes
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : q.isLoading || !data || !quota ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <p className="text-sm">
                Hoy:{' '}
                <span className="font-semibold tabular-nums">
                  {formatCount(quota.used)} de {formatCount(quota.cap)}
                </span>{' '}
                inspecciones
                {quota.queued > 0 && ` · ${formatCount(quota.queued)} en la cola`}
              </p>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={quota.used}
                aria-valuemin={0}
                aria-valuemax={quota.cap}
                aria-label="Cuota de inspecciones de hoy"
              >
                <div
                  className={cn(
                    'h-full rounded-full',
                    usedPct >= 100 ? 'bg-red-500' : usedPct >= 80 ? 'bg-amber-500' : 'bg-primary',
                  )}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Google deja {formatCount(quota.googleLimit)} al día por propiedad de Search Console;
                el día se cuenta en la hora del Pacífico y se reinicia el{' '}
                {formatDateTime(quota.resetsAt)}.
              </p>
              {quota.waitingNextDay > 0 && (
                <p className="flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {formatCount(quota.waitingNextDay)} esperan a que se reinicie la cuota (se ha
                  llegado al tope de hoy).
                </p>
              )}
            </div>

            {canEdit && (
              <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://tuweb.es/pagina o /pagina"
                  aria-label="URL que inspeccionar"
                  className="min-w-0"
                />
                <Button type="submit" disabled={inspect.isPending || !url.trim()}>
                  {inspect.isPending ? (
                    <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                  ) : (
                    <ScanSearch className="mr-1 size-4" aria-hidden />
                  )}
                  Inspeccionar
                </Button>
              </form>
            )}

            <div className="flex flex-wrap gap-1.5 text-sm">
              {(
                [
                  ['all', `Todas (${formatCount(data.summary.urls)})`],
                  ['not_indexed', `No indexadas (${formatCount(data.summary.notIndexed)})`],
                  [
                    'canonical',
                    `Canónica distinta (${formatCount(data.summary.canonicalMismatch)})`,
                  ],
                  ['pending', 'En espera'],
                ] as [Filter, string][]
              ).map(([k, text]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  aria-pressed={filter === k}
                  className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
                >
                  {text}
                </button>
              ))}
            </div>

            {items.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {data.items.length === 0
                  ? 'Aún no se ha inspeccionado ninguna URL.'
                  : 'Ninguna URL con este filtro.'}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {items.map((i) => {
                  const s = statusOf(i);
                  return (
                    <li key={i.id} className="space-y-1.5 p-3">
                      <button
                        type="button"
                        onClick={() => setDetail(i)}
                        className="block max-w-full break-all text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                      >
                        {i.url}
                      </button>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {s ? <SeoIndexStatusBadge status={s} /> : <PendingBadge i={i} />}
                        <span className="text-xs text-muted-foreground">
                          {SEO_INSPECTION_REASON_LABELS[i.reason]}
                          {i.lastCrawlAt && ` · último rastreo ${formatDateTime(i.lastCrawlAt)}`}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setHistoryUrl(i.url)}
                          className="h-8 px-2"
                        >
                          <History className="mr-1 size-4" aria-hidden /> Historial
                        </Button>
                        <InspectUrlButton
                          scope={scope}
                          url={i.url}
                          canEdit={canEdit}
                          label="Volver a inspeccionar"
                          variant="ghost"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Origen: inspección de URL de Google (Search Console). Cada URL guarda todas sus
              inspecciones.
            </p>
          </>
        )}
      </CardContent>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-6">{detail?.url}</DialogTitle>
            <DialogDescription>Lo que dice Google de esta URL</DialogDescription>
          </DialogHeader>
          {detail && <InspectionDetail i={detail} />}
        </DialogContent>
      </Dialog>
      <HistoryDialog scope={scope} url={historyUrl} onClose={() => setHistoryUrl(null)} />
      {data && (
        <TechnicalSettingsDialog
          scope={scope}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={data.settings}
        />
      )}
    </Card>
  );
}

function HistoryDialog({
  scope,
  url,
  onClose,
}: {
  scope: TechnicalScope;
  url: string | null;
  onClose: () => void;
}) {
  const h = useInspectionHistory(scope, url);
  return (
    <Dialog open={!!url} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="break-all pr-6">{url}</DialogTitle>
          <DialogDescription>
            Todas sus inspecciones, de la más reciente a la más antigua
          </DialogDescription>
        </DialogHeader>
        {h.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="space-y-4">
            {(h.data?.items ?? []).map((i) => (
              <li key={i.id} className="space-y-2 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(i.inspectedAt ?? i.createdAt)}
                </p>
                <InspectionDetail i={i} />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Tope de inspecciones, lote diario y medición semanal de la velocidad. */
export function TechnicalSettingsDialog({
  scope,
  open,
  onOpenChange,
  settings,
}: {
  scope: TechnicalScope;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: SeoTechnicalSettings;
}) {
  const update = useUpdateTechnicalSettings(scope);
  const [draft, setDraft] = useState<SeoTechnicalSettings>(settings);
  // En el panel admin solo se editan los proyectos de la plataforma.
  const ranges = SEO_TECHNICAL_RANGES[scope.kind === 'admin' ? 'platform' : 'tenant'];
  const save = async (reset = false) => {
    try {
      await update.mutateAsync(reset ? { reset: true } : draft);
      toast.success('Ajustes guardados');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const num = (k: keyof typeof ranges) => (
    <div className="space-y-1">
      <Label htmlFor={`tech-${k}`}>{ranges[k].label}</Label>
      <Input
        id={`tech-${k}`}
        type="number"
        inputMode="numeric"
        min={ranges[k].min}
        max={ranges[k].max}
        value={draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
      />
    </div>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) setDraft(settings);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Inspección y velocidad</DialogTitle>
          <DialogDescription>
            Cuánto se pide a Google cada día y cada semana. Google deja 2.000 inspecciones al día
            por propiedad; PageSpeed no tiene coste.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {num('inspectionDailyCap')}
          <div className="flex items-start gap-2">
            <Checkbox
              id="tech-batch"
              checked={draft.inspectionBatchEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, inspectionBatchEnabled: v === true })}
            />
            <Label htmlFor="tech-batch" className="font-normal leading-snug">
              Inspeccionar solas cada día las URL objetivo de las palabras importantes, las páginas
              que no deberían estar en Google y las de más clics.
            </Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {num('inspectionBatchMax')}
            {num('inspectionReinspectDays')}
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="tech-psi"
              checked={draft.pagespeedEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, pagespeedEnabled: v === true })}
            />
            <Label htmlFor="tech-psi" className="font-normal leading-snug">
              Medir la velocidad cada lunes (la portada, las URL objetivo importantes y las páginas
              de más clics), en móvil y en ordenador.
            </Label>
          </div>
          {num('pagespeedMaxUrls')}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => void save(true)} disabled={update.isPending}>
            Valores por defecto
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
