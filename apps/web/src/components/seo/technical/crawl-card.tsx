'use client';

import {
  SEO_CRAWL_ISSUE_GROUPS,
  SEO_CRAWL_ISSUE_GROUP_LABELS,
  SEO_CRAWL_RANGES,
  SEO_CRAWL_STATUS_LABELS,
  SEO_SEVERITY_LABELS,
  SEO_WEEKDAY_LABELS,
  type SeoCrawlDto,
  type SeoCrawlSettings,
} from '@storageos/shared';
import { Download, Info, Link2, Loader2, Radar, Settings2, Square } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { IssueRow, SEVERITY_TONE } from './crawl-bits';
import { CrawlPageSheet } from './crawl-page-sheet';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { formatCount, formatDateTime } from '@/lib/format';
import {
  type CrawlIssueFilters,
  type CrawlPageFilters,
  type TechnicalScope,
  downloadCrawlIssuesCsv,
  useCancelCrawl,
  useCrawlInternalLinks,
  useCrawlIssues,
  useCrawlPages,
  useSeoCrawl,
  useStartCrawl,
  useUpdateCrawlSettings,
} from '@/lib/seo-advanced/technical-hooks';
import { cn } from '@/lib/utils';

const duration = (ms: number | null) => {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const STOP_TEXT = {
  max_pages: 'Se paró al llegar al tope de páginas: sube el tope si quieres que lo recorra todo.',
  max_time: 'Se paró al llegar al tiempo máximo del rastreo.',
} as const;

/** Resumen de un rastreo: páginas, incidencias por gravedad y comparación con el anterior. */
function CrawlSummary({ crawl }: { crawl: SeoCrawlDto }) {
  const s = crawl.summary;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">Último rastreo:</span>{' '}
          {formatDateTime(crawl.finishedAt ?? crawl.createdAt)}
          {crawl.createdBy
            ? ` · ${crawl.createdBy}`
            : crawl.trigger === 'scheduled'
              ? ' · semanal'
              : ''}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatCount(crawl.pagesCrawled)} páginas pedidas · {duration(crawl.durationMs)}
          {crawl.errors > 0 && ` · ${formatCount(crawl.errors)} con error`}
        </p>
      </div>
      {s && (
        <div className="flex flex-wrap gap-1.5">
          {(['high', 'medium', 'low'] as const).map((k) => (
            <Badge key={k} variant="outline" className={cn('font-normal', SEVERITY_TONE[k])}>
              {SEO_SEVERITY_LABELS[k]}: {formatCount(s.bySeverity[k] ?? 0)}
            </Badge>
          ))}
          <Badge variant="outline" className="font-normal">
            Nuevas: {formatCount(s.newIssues)}
          </Badge>
          <Badge variant="outline" className="font-normal">
            Resueltas: {formatCount(s.resolvedIssues)}
          </Badge>
          <Badge variant="outline" className="font-normal">
            Siguen: {formatCount(s.continuingIssues)}
          </Badge>
        </div>
      )}
      {crawl.stopReason && (
        <p className="flex gap-1.5 text-sm text-amber-900 dark:text-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {STOP_TEXT[crawl.stopReason]}
        </p>
      )}
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p>
          <span className="font-medium text-foreground">robots.txt:</span>{' '}
          {crawl.robots?.found
            ? crawl.robots.rules.length > 0
              ? `${crawl.robots.rules.join(' · ')}`
              : 'no bloquea nada a este rastreador'
            : 'no hay (todo se puede rastrear)'}
          {crawl.robots && crawl.robots.blockedCount > 0 && (
            <> · no se han pedido {formatCount(crawl.robots.blockedCount)} URL que bloquea</>
          )}
        </p>
        <p>
          <span className="font-medium text-foreground">Mapas del sitio:</span>{' '}
          {crawl.sitemaps && crawl.sitemaps.urls.length > 0
            ? `${formatCount(crawl.sitemaps.urls.length)} leídos, ${formatCount(crawl.sitemaps.pages)} páginas`
            : 'ninguno'}
          {crawl.sitemaps && crawl.sitemaps.errors.length > 0 && (
            <> · {formatCount(crawl.sitemaps.errors.length)} con error</>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * «Rastreo»: el rastreador propio recorre la web del proyecto como lo haría
 * Google (respetando robots.txt) y avisa de lo técnico: errores, títulos,
 * canónicas, enlaces rotos, huérfanas, mapa del sitio y enlazado interno.
 */
export function SeoCrawlCard({ scope, canEdit }: { scope: TechnicalScope; canEdit: boolean }) {
  const q = useSeoCrawl(scope);
  const start = useStartCrawl(scope);
  const cancel = useCancelCrawl(scope);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState('issues');
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const run = async () => {
    try {
      const r = await start.mutateAsync();
      toast.success(
        r.alreadyRunning ? 'Ya hay un rastreo en marcha' : 'Rastreo en marcha: tarda unos minutos',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const stop = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      toast.success('Rastreo cancelado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const data = q.data;
  const live = data?.live ?? null;
  return (
    <Card id="rastreo" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle>Rastreo</CardTitle>
          <CardDescription>
            Nuestro rastreador recorre tu web como lo haría Google (respeta tu robots.txt, sigue los
            enlaces y lee el mapa del sitio) y te dice qué hay que arreglar.
          </CardDescription>
        </div>
        {canEdit && data && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {live ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void stop(live.id)}
                disabled={cancel.isPending}
              >
                <Square className="mr-1 size-4" aria-hidden /> Cancelar
              </Button>
            ) : (
              <Button size="sm" onClick={() => void run()} disabled={start.isPending}>
                {start.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                ) : (
                  <Radar className="mr-1 size-4" aria-hidden />
                )}
                Rastrear ahora
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-1 size-4" aria-hidden /> Ajustes
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : q.isLoading || !data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {live && (
              <div className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                <span>
                  {SEO_CRAWL_STATUS_LABELS[live.status]}: {formatCount(live.pagesCrawled)} páginas
                  pedidas de {formatCount(live.pagesFound)} encontradas.
                </span>
              </div>
            )}
            {data.last ? (
              <CrawlSummary crawl={data.last} />
            ) : (
              !live && (
                <p className="text-sm text-muted-foreground">
                  Aún no se ha rastreado la web.{' '}
                  {canEdit ? 'Pulsa «Rastrear ahora» para empezar.' : ''}
                </p>
              )
            )}
            {data.history.some((h) => h.status === 'failed') && (
              <p className="text-sm text-red-700 dark:text-red-300">
                El último rastreo con error:{' '}
                {data.history.find((h) => h.status === 'failed')?.error ?? 'sin detalle'}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Rastreo semanal:{' '}
              {data.settings.weeklyEnabled
                ? `los ${SEO_WEEKDAY_LABELS[data.settings.weekday]} a las ${String(data.settings.hour).padStart(2, '0')}:00`
                : 'apagado'}
              {' · '}hasta {formatCount(data.settings.maxPages)} páginas, una cada{' '}
              {(data.settings.pauseMs / 1000).toLocaleString('es-ES')} s. Se identifica como{' '}
              <code className="break-all">{data.userAgent}</code>.
            </p>

            {data.last && (
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="flex h-auto w-full flex-wrap justify-start">
                  <TabsTrigger value="issues">Incidencias</TabsTrigger>
                  <TabsTrigger value="pages">Páginas</TabsTrigger>
                  <TabsTrigger value="orphans">Huérfanas</TabsTrigger>
                  <TabsTrigger value="links">Enlazado interno</TabsTrigger>
                </TabsList>
                <TabsContent value="issues" className="mt-3">
                  <IssuesPanel scope={scope} canEdit={canEdit} onOpenUrl={setPageUrl} />
                </TabsContent>
                <TabsContent value="pages" className="mt-3">
                  <PagesPanel scope={scope} onOpenUrl={setPageUrl} initial="all" />
                </TabsContent>
                <TabsContent value="orphans" className="mt-3">
                  <p className="mb-2 text-sm text-muted-foreground">
                    Páginas que están en el mapa del sitio o tienen impresiones en Google, pero a
                    las que no llega ningún enlace de tu web.
                  </p>
                  <PagesPanel scope={scope} onOpenUrl={setPageUrl} initial="orphans" fixed />
                </TabsContent>
                <TabsContent value="links" className="mt-3">
                  <InternalLinksPanel scope={scope} onOpenUrl={setPageUrl} />
                </TabsContent>
              </Tabs>
            )}
          </>
        )}
      </CardContent>
      {data && (
        <CrawlSettingsDialog
          scope={scope}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={data.settings}
        />
      )}
      <CrawlPageSheet
        scope={scope}
        url={pageUrl}
        canEdit={canEdit}
        onClose={() => setPageUrl(null)}
        onOpenUrl={setPageUrl}
      />
    </Card>
  );
}

// ----------------------------------------------------------- incidencias

const ALL = 'all';

function IssuesPanel({
  scope,
  canEdit,
  onOpenUrl,
}: {
  scope: TechnicalScope;
  canEdit: boolean;
  onOpenUrl: (url: string) => void;
}) {
  const [filters, setFilters] = useState<CrawlIssueFilters>({
    severity: '',
    group: '',
    view: 'open',
    onlyNew: false,
    search: '',
  });
  const q = useCrawlIssues(scope, filters);
  const [csvBusy, setCsvBusy] = useState(false);
  const csv = async () => {
    setCsvBusy(true);
    try {
      await downloadCrawlIssuesCsv(scope, filters);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setCsvBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Select
          value={filters.severity || ALL}
          onValueChange={(v) => setFilters({ ...filters, severity: v === ALL ? '' : v })}
        >
          <SelectTrigger className="h-9 sm:w-[150px]" aria-label="Gravedad">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toda gravedad</SelectItem>
            {(['high', 'medium', 'low'] as const).map((s) => (
              <SelectItem key={s} value={s}>
                {SEO_SEVERITY_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.group || ALL}
          onValueChange={(v) => setFilters({ ...filters, group: v === ALL ? '' : v })}
        >
          <SelectTrigger className="h-9 sm:w-[230px]" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {SEO_CRAWL_ISSUE_GROUPS.map((g) => (
              <SelectItem key={g} value={g}>
                {SEO_CRAWL_ISSUE_GROUP_LABELS[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.view}
          onValueChange={(v) => setFilters({ ...filters, view: v as CrawlIssueFilters['view'] })}
        >
          <SelectTrigger className="h-9 sm:w-[150px]" aria-label="Estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Pendientes</SelectItem>
            <SelectItem value="resolved">Resueltas</SelectItem>
            <SelectItem value="all">Todas</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          placeholder="Buscar en la URL"
          aria-label="Buscar en la URL"
          className="h-9 min-w-0 sm:w-[200px]"
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="crawl-only-new"
            checked={filters.onlyNew}
            onCheckedChange={(v) => setFilters({ ...filters, onlyNew: v === true })}
          />
          <Label htmlFor="crawl-only-new" className="font-normal">
            Solo nuevas
          </Label>
        </div>
        <Button variant="outline" size="sm" onClick={() => void csv()} disabled={csvBusy}>
          <Download className="mr-1 size-4" aria-hidden /> CSV
        </Button>
      </div>
      {q.isError ? (
        <SectionError onRetry={() => void q.refetch()} />
      ) : q.isLoading || !q.data ? (
        <div className="flex justify-center py-4">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : q.data.items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {filters.view === 'open'
            ? 'Nada pendiente con estos filtros.'
            : 'Ninguna con estos filtros.'}
        </p>
      ) : (
        <>
          {q.data.total > q.data.items.length && (
            <p className="text-xs text-muted-foreground">
              Se enseñan {formatCount(q.data.items.length)} de {formatCount(q.data.total)}. Filtra o
              descarga el CSV para verlas todas.
            </p>
          )}
          <ul className="divide-y rounded-md border">
            {q.data.items.map((i) => (
              <IssueRow key={i.id} i={i} scope={scope} canEdit={canEdit} onOpenUrl={onOpenUrl} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- páginas

const PAGE_FILTER_LABELS: Record<CrawlPageFilters['filter'], string> = {
  all: 'Todas',
  issues: 'Con incidencias',
  errors: 'Con error',
  redirects: 'Redirigen',
  noindex: 'Con «noindex»',
  blocked: 'Bloqueadas por robots.txt',
  orphans: 'Huérfanas',
};

function PagesPanel({
  scope,
  onOpenUrl,
  initial,
  fixed = false,
}: {
  scope: TechnicalScope;
  onOpenUrl: (url: string) => void;
  initial: CrawlPageFilters['filter'];
  fixed?: boolean;
}) {
  const [filters, setFilters] = useState<CrawlPageFilters>({ filter: initial, search: '' });
  const q = useCrawlPages(scope, filters);
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!fixed && (
          <Select
            value={filters.filter}
            onValueChange={(v) =>
              setFilters({ ...filters, filter: v as CrawlPageFilters['filter'] })
            }
          >
            <SelectTrigger className="h-9 sm:w-[220px]" aria-label="Qué páginas">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PAGE_FILTER_LABELS) as CrawlPageFilters['filter'][])
                .filter((k) => k !== 'orphans')
                .map((k) => (
                  <SelectItem key={k} value={k}>
                    {PAGE_FILTER_LABELS[k]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
        <Input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          placeholder="Buscar en la URL"
          aria-label="Buscar página"
          className="h-9 min-w-0 sm:w-[240px]"
        />
      </div>
      {q.isError ? (
        <SectionError onRetry={() => void q.refetch()} />
      ) : q.isLoading || !q.data ? (
        <div className="flex justify-center py-4">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : q.data.items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {fixed ? 'No hay páginas huérfanas.' : 'Ninguna página con este filtro.'}
        </p>
      ) : (
        <>
          {q.data.total > q.data.items.length && (
            <p className="text-xs text-muted-foreground">
              Se enseñan {formatCount(q.data.items.length)} de {formatCount(q.data.total)}.
            </p>
          )}
          <ul className="divide-y rounded-md border">
            {q.data.items.map((p) => (
              <li key={p.id} className="space-y-1 p-3">
                <button
                  type="button"
                  onClick={() => onOpenUrl(p.url)}
                  className="block max-w-full break-all text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {p.url}
                </button>
                <p className="text-xs text-muted-foreground">
                  {p.robotsBlocked
                    ? 'Bloqueada por robots.txt (no se pidió)'
                    : p.error
                      ? `No se pudo leer: ${p.error}`
                      : `Responde ${p.status ?? '—'}`}
                  {p.depth !== null &&
                    ` · a ${p.depth} clic${p.depth === 1 ? '' : 's'} de la portada`}
                  {` · ${formatCount(p.inlinks)} enlace${p.inlinks === 1 ? '' : 's'} le llega${p.inlinks === 1 ? '' : 'n'}`}
                  {p.impressions > 0 && ` · ${formatCount(p.impressions)} impresiones`}
                  {p.inSitemap && ' · en el mapa del sitio'}
                  {p.noindex && ' · «noindex»'}
                  {p.issues > 0 &&
                    ` · ${formatCount(p.issues)} incidencia${p.issues === 1 ? '' : 's'}`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------- enlazado interno

function InternalLinksPanel({
  scope,
  onOpenUrl,
}: {
  scope: TechnicalScope;
  onOpenUrl: (url: string) => void;
}) {
  const q = useCrawlInternalLinks(scope);
  if (q.isError) return <SectionError onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const d = q.data;
  if (d.items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        Pon la URL objetivo de tus palabras seguidas para ver cuántos enlaces internos les llegan.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Cuántos enlaces de tu web llegan a la página que quieres que salga para cada palabra. Con
        menos de {formatCount(d.min)}, conviene enlazarla desde las páginas sugeridas (las que ya
        salen en Google para búsquedas parecidas).
      </p>
      <ul className="divide-y rounded-md border">
        {d.items.map((it) => (
          <li key={it.urlKey} className="space-y-1.5 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  'font-normal tabular-nums',
                  it.few
                    ? 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300'
                    : 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300',
                )}
              >
                <Link2 className="mr-1 size-3" aria-hidden />
                {formatCount(it.inlinks)} enlace{it.inlinks === 1 ? '' : 's'}
              </Badge>
              {!it.crawled && (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  El rastreo no llegó a ella
                </Badge>
              )}
            </div>
            <button
              type="button"
              onClick={() => onOpenUrl(it.url)}
              className="block max-w-full break-all text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {it.url}
            </button>
            <p className="text-xs text-muted-foreground">
              Para {it.keywords.map((k) => `«${k.keyword}»`).join(', ')}
              {it.depth !== null && ` · a ${it.depth} clics de la portada`}
            </p>
            {it.sources.length > 0 && (
              <p className="break-all text-xs text-muted-foreground">
                La enlazan: {it.sources.slice(0, 5).join(', ')}
                {it.sources.length > 5 && ` y ${formatCount(it.sources.length - 5)} más`}
              </p>
            )}
            {it.few && it.suggestions.length > 0 && (
              <div className="text-xs">
                <p className="font-medium">Enlázala desde:</p>
                <ul className="mt-1 space-y-0.5">
                  {it.suggestions.map((s) => (
                    <li key={s.url} className="break-all text-muted-foreground">
                      {s.url} — {formatCount(s.impressions)} impresiones (p. ej. «{s.query}»)
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- ajustes

function CrawlSettingsDialog({
  scope,
  open,
  onOpenChange,
  settings,
}: {
  scope: TechnicalScope;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: SeoCrawlSettings;
}) {
  const update = useUpdateCrawlSettings(scope);
  const [draft, setDraft] = useState<SeoCrawlSettings>(settings);
  const [exclude, setExclude] = useState(settings.excludePaths.join('\n'));
  // En el panel admin solo se editan los proyectos de la plataforma.
  const ranges = SEO_CRAWL_RANGES[scope.kind === 'admin' ? 'platform' : 'tenant'];
  const save = async (reset = false) => {
    try {
      await update.mutateAsync(
        reset
          ? { reset: true }
          : {
              weeklyEnabled: draft.weeklyEnabled,
              weekday: draft.weekday,
              hour: draft.hour,
              maxPages: draft.maxPages,
              pauseMs: draft.pauseMs,
              maxMinutes: draft.maxMinutes,
              excludePaths: exclude
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean),
            },
      );
      toast.success('Ajustes guardados');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const num = (k: 'maxPages' | 'pauseMs' | 'maxMinutes') => (
    <div className="space-y-1">
      <Label htmlFor={`crawl-${k}`}>{ranges[k].label}</Label>
      <Input
        id={`crawl-${k}`}
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
        if (v) {
          setDraft(settings);
          setExclude(settings.excludePaths.join('\n'));
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajustes del rastreo</DialogTitle>
          <DialogDescription>
            Cuándo se rastrea solo, hasta dónde y con qué pausa entre página y página (para no
            cargar tu web).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <Checkbox
              id="crawl-weekly"
              checked={draft.weeklyEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, weeklyEnabled: v === true })}
            />
            <Label htmlFor="crawl-weekly" className="font-normal leading-snug">
              Rastrear la web solo una vez por semana.
            </Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Día</Label>
              <Select
                value={String(draft.weekday)}
                onValueChange={(v) => setDraft({ ...draft, weekday: Number(v) })}
              >
                <SelectTrigger aria-label="Día de la semana">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEO_WEEKDAY_LABELS.map((d, idx) => (
                    <SelectItem key={d} value={String(idx)}>
                      {d.charAt(0).toUpperCase() + d.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Hora (España)</Label>
              <Select
                value={String(draft.hour)}
                onValueChange={(v) => setDraft({ ...draft, hour: Number(v) })}
              >
                <SelectTrigger aria-label="Hora">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {num('maxPages')}
            {num('pauseMs')}
            {num('maxMinutes')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="crawl-exclude">Rutas que no se rastrean (una por línea)</Label>
            <Textarea
              id="crawl-exclude"
              rows={4}
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder={'/blog/etiqueta\n?pagina\n*/imprimir*'}
            />
            <p className="text-xs text-muted-foreground">
              «/ruta» deja fuera esa ruta y lo que cuelga de ella; «?parámetro», las URL con ese
              parámetro; «*texto*», las que lo contienen.
            </p>
          </div>
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
