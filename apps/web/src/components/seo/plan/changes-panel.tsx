'use client';

import {
  SEO_SITE_CHANGE_TYPES,
  SEO_SITE_CHANGE_TYPE_LABELS,
  SEO_SITE_CHANGE_VERDICT_LABELS,
  type SeoDashboardDayDto,
  type SeoSiteChangeCompareDto,
  type SeoSiteChangeDto,
  type SeoSiteChangeType,
  type SeoSiteChangeVerdict,
  type SeoSiteChangeWindowDto,
  type SeoTotalsDto,
} from '@storageos/shared';
import { Download, Loader2, Pencil, Plus, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SeoTrendChart } from '../seo-charts';
import { seoErrorMessage } from '../seo-errors';

import { ChangeDialog, type ChangeDraft, type PlanDomain } from './plan-dialogs';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import {
  type ChangeFilters,
  type PlanScope,
  saveCsv,
  siteChangesCsv,
  useSiteChangeDetail,
  useSiteChanges,
} from '@/lib/seo-advanced/plan-hooks';
import { cn } from '@/lib/utils';

const ALL = '__all__';

const VERDICT_STYLE: Record<SeoSiteChangeVerdict, string> = {
  better: 'border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  worse: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  flat: 'border-transparent bg-muted text-muted-foreground',
  insufficient: 'text-muted-foreground',
};

/** Lo que dice una ventana cuando aún no se puede comparar. */
function pendingText(w: SeoSiteChangeWindowDto): string {
  if (w.status === 'waiting') {
    return w.daysLeft !== null
      ? `Faltan ${w.daysLeft} ${w.daysLeft === 1 ? 'día' : 'días'} (disponible el ${formatDate(w.availableOn)})`
      : 'Google aún no ha dado todos sus días';
  }
  if (w.status === 'no_history') return 'Sin datos de Google de antes del cambio';
  return 'Periodo incompleto: faltan días de Google';
}

/** El resultado de una ventana en una etiqueta (o por qué aún no hay). */
export function WindowBadge({ w }: { w: SeoSiteChangeWindowDto }) {
  if (w.scope) {
    return (
      <Badge variant="outline" className={cn('font-normal', VERDICT_STYLE[w.scope.verdict])}>
        {w.days} d: {SEO_SITE_CHANGE_VERDICT_LABELS[w.scope.verdict]}
      </Badge>
    );
  }
  const short =
    w.status === 'waiting'
      ? w.daysLeft !== null
        ? `faltan ${w.daysLeft} d`
        : 'esperando a Google'
      : w.status === 'no_history'
        ? 'sin histórico'
        : 'incompleto';
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground" title={pendingText(w)}>
      {w.days} d: {short}
    </Badge>
  );
}

const pos = (t: SeoTotalsDto) => (t.position === null ? '—' : formatNumber(t.position, 1));
const ctr = (t: SeoTotalsDto) => (t.ctr === null ? '—' : formatPct(t.ctr * 100, 1));

function CompareTable({
  c,
  site,
}: {
  c: SeoSiteChangeCompareDto;
  site: SeoSiteChangeWindowDto['site'];
}) {
  const rows: [string, (t: SeoTotalsDto) => string][] = [
    ['Clics', (t) => formatCount(t.clicks)],
    ['Impresiones', (t) => formatCount(t.impressions)],
    ['CTR', ctr],
    ['Posición media', pos],
  ];
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[420px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium" />
            <th className="px-3 py-2 text-right font-medium">Antes</th>
            <th className="px-3 py-2 text-right font-medium">Después</th>
            {site && <th className="px-3 py-2 text-right font-medium">Sitio: antes → después</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(([label, fmt]) => (
            <tr key={label}>
              <td className="px-3 py-2 text-muted-foreground">{label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(c.before)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(c.after)}</td>
              {site && (
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {fmt(site.before)} → {fmt(site.after)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WindowDetail({ w }: { w: SeoSiteChangeWindowDto }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Antes: {formatDate(w.beforeFrom)} – {formatDate(w.beforeTo)} · Después:{' '}
        {formatDate(w.afterFrom)} – {formatDate(w.afterTo)} (el día del cambio no cuenta).
      </p>
      {w.overlaps.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Resultado mezclado con{' '}
            {w.overlaps
              .map((o) => `la actuación del ${formatDate(o.date)} («${o.title}»)`)
              .join(', ')}
            : tocan lo mismo en estas fechas.
          </span>
        </p>
      )}
      {!w.scope ? (
        <p className="text-muted-foreground">{pendingText(w)}.</p>
      ) : (
        <>
          <p>
            <Badge
              variant="outline"
              className={cn('mr-1 font-normal', VERDICT_STYLE[w.scope.verdict])}
            >
              {SEO_SITE_CHANGE_VERDICT_LABELS[w.scope.verdict]}
            </Badge>
            {w.scope.text}
          </p>
          {w.contextNote && <p className="text-muted-foreground">{w.contextNote}</p>}
          <CompareTable c={w.scope} site={w.site} />
          {w.yearAgo && (
            <div className="space-y-1 rounded-md border p-2 text-xs">
              <p className="font-medium">Lo mismo, un año antes</p>
              {w.yearAgo.available && w.yearAgo.before && w.yearAgo.after ? (
                <p className="text-muted-foreground">
                  Las mismas fechas del año pasado: {formatCount(w.yearAgo.before.clicks)} →{' '}
                  {formatCount(w.yearAgo.after.clicks)} clics ·{' '}
                  {formatCount(w.yearAgo.before.impressions)} →{' '}
                  {formatCount(w.yearAgo.after.impressions)} impresiones. Si entonces también subió
                  o bajó, parte del cambio de ahora es de la temporada y no de la actuación.
                </p>
              ) : (
                <p className="text-muted-foreground">{w.yearAgo.message}</p>
              )}
            </div>
          )}
          {w.items.length > 1 && (
            <ul className="space-y-2">
              {w.items.map((i) => (
                <li key={`${i.kind}-${i.label}`} className="rounded-md border p-2">
                  <p className="break-all font-medium">
                    {i.kind === 'url' ? 'URL' : 'Palabra'}: {i.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatCount(i.before.clicks)} → {formatCount(i.after.clicks)} clics ·{' '}
                    {formatCount(i.before.impressions)} → {formatCount(i.after.impressions)}{' '}
                    impresiones · posición {pos(i.before)} → {pos(i.after)}
                  </p>
                  <p className="text-xs">{i.text}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Datos reales de Search Console. «Coincide con» no quiere decir que lo haya causado el
            cambio.
          </p>
        </>
      )}
    </div>
  );
}

function ChangeSheet({
  scope,
  id,
  canEdit,
  onClose,
  onEdit,
}: {
  scope: PlanScope;
  id: string | null;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (c: SeoSiteChangeDto) => void;
}) {
  const detail = useSiteChangeDetail(scope, id);
  const [days, setDays] = useState(28);
  const c = detail.data;
  const w = c?.windows.find((x) => x.days === days) ?? null;
  // El gráfico: la ventana elegida a cada lado del cambio.
  const chartDays: SeoDashboardDayDto[] = useMemo(() => {
    if (!c || !w) return [];
    return c.daily.filter((d) => d.date >= w.beforeFrom && d.date <= w.afterTo);
  }, [c, w]);
  return (
    <Sheet open={id !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-words pr-6">{c?.title ?? 'Actuación'}</SheetTitle>
          <SheetDescription>
            {c
              ? `${SEO_SITE_CHANGE_TYPE_LABELS[c.type]} · ${formatDate(c.date)}${c.time ? ` a las ${c.time}` : ''}${c.domain ? ` · ${c.domain}` : ''}`
              : ' '}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {detail.isError ? (
            <SectionError onRetry={() => void detail.refetch()} />
          ) : detail.isLoading || !c ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {c.description && <p className="whitespace-pre-wrap text-sm">{c.description}</p>}
              <div className="space-y-1 text-sm">
                <p className="break-all">
                  <span className="text-muted-foreground">URLs: </span>
                  {c.urls.length ? c.urls.join(' · ') : 'ninguna'}
                </p>
                <p>
                  <span className="text-muted-foreground">Palabras: </span>
                  {c.keywords.length ? c.keywords.join(', ') : 'ninguna'}
                </p>
                {c.urls.length === 0 && c.keywords.length === 0 && (
                  <p className="text-muted-foreground">Sin alcance: se compara el sitio entero.</p>
                )}
                {c.taskTitle && (
                  <p>
                    <span className="text-muted-foreground">Tarea: </span>
                    {c.taskTitle}
                  </p>
                )}
                {c.createdByName && (
                  <p className="text-xs text-muted-foreground">Apuntada por {c.createdByName}</p>
                )}
              </div>
              <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Días">
                {c.windows.map((x) => (
                  <Button
                    key={x.days}
                    size="sm"
                    variant={days === x.days ? 'secondary' : 'ghost'}
                    className="h-7 px-3"
                    aria-pressed={days === x.days}
                    onClick={() => setDays(x.days)}
                  >
                    {x.days} días
                  </Button>
                ))}
              </div>
              {w && <WindowDetail w={w} />}
              {chartDays.length > 0 && (
                <div className="grid gap-4">
                  <SeoTrendChart
                    title="Clics del alcance"
                    metric="clicks"
                    days={chartDays}
                    compare={false}
                    markers={c.markers}
                  />
                  <SeoTrendChart
                    title="Posición media (arriba es mejor)"
                    metric="position"
                    days={chartDays}
                    compare={false}
                    markers={c.markers}
                  />
                </div>
              )}
              {c.notes && (
                <p className="whitespace-pre-wrap text-sm">
                  <span className="text-muted-foreground">Notas: </span>
                  {c.notes}
                </p>
              )}
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => onEdit(c)}>
                  <Pencil className="mr-1 size-4" aria-hidden /> Editar
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Actuaciones: los cambios hechos en la web con su resultado a 7, 28 y 90
 * días, y su ficha con el antes y después, el detalle por URL y por palabra y
 * el gráfico con las marcas.
 */
export function SeoChangesPanel({
  scope,
  canEdit,
  domains,
  onRecord,
}: {
  scope: PlanScope;
  canEdit: boolean;
  domains: PlanDomain[];
  onRecord: (draft: ChangeDraft | null) => void;
}) {
  const [type, setType] = useState<SeoSiteChangeType | null>(null);
  const [domainId, setDomainId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<SeoSiteChangeDto | null>(null);
  const [downloading, setDownloading] = useState(false);
  const filters: ChangeFilters = { type, domainId, search };
  const list = useSiteChanges(scope, filters);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

  const csv = async () => {
    setDownloading(true);
    try {
      saveCsv(await siteChangesCsv(scope, filters), 'actuaciones-seo.csv');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={type ?? ALL}
          onValueChange={(v) => setType(v === ALL ? null : (v as SeoSiteChangeType))}
        >
          <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] sm:w-48" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {SEO_SITE_CHANGE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {SEO_SITE_CHANGE_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {domains.length > 1 && (
          <Select value={domainId ?? ALL} onValueChange={(v) => setDomainId(v === ALL ? null : v)}>
            <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] sm:w-48" aria-label="Dominio">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los dominios</SelectItem>
              {domains.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar"
          aria-label="Buscar actuaciones"
          className="h-8 w-full sm:w-44"
        />
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void csv()} disabled={downloading}>
            <Download className="mr-1 size-4" aria-hidden /> CSV
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => onRecord(null)}>
              <Plus className="mr-1 size-4" aria-hidden /> Registrar
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Cada actuación se compara con los mismos días de antes cuando han pasado 7, 28 y 90 días y
        Google ha dado sus datos (unos 3 días más).
      </p>

      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Aún no hay actuaciones. Apunta cada cambio en la web (un título, un texto, una
          redirección…) para ver después si coincide con una mejora.
        </p>
      ) : (
        <>
          <ul className="divide-y rounded-md border">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setOpen(c.id)}
                  className="flex w-full flex-col gap-2 p-3 text-left hover:bg-muted/50"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0 break-words text-sm font-medium">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(c.date)} · {SEO_SITE_CHANGE_TYPE_LABELS[c.type]}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {c.windows.map((w) => (
                      <WindowBadge key={w.days} w={w} />
                    ))}
                    {c.windows.some((w) => w.overlaps.length > 0) && (
                      <Badge
                        variant="outline"
                        className="border-amber-300 font-normal text-amber-800 dark:border-amber-900 dark:text-amber-300"
                      >
                        Se solapa con otra
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {items.length} de {total}
            </span>
            {list.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                Cargar más
              </Button>
            )}
          </div>
        </>
      )}

      <ChangeSheet
        scope={scope}
        id={open}
        canEdit={canEdit}
        onClose={() => setOpen(null)}
        onEdit={(c) => setEditing(c)}
      />
      <ChangeDialog
        scope={scope}
        domains={domains}
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        change={editing}
        onSaved={() => setEditing(null)}
        onDeleted={() => setOpen(null)}
      />
    </div>
  );
}
