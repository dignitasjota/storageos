'use client';

import {
  SEO_INTENT_SOURCE_LABELS,
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  SEO_NO_GROUP,
  SEO_NO_INTENT,
  SEO_TARGET_STATUSES,
  SEO_TARGET_STATUS_LABELS,
  SEO_TRACKED_PERIODS,
  seoMasterOriginLabel,
  type SeoKeywordIntent,
  type SeoProjectDomainDto,
  type SeoProjectKeywordDto,
  type SeoTargetStatus,
  type SeoTrackedGroupDto,
  type SeoTrackedKeywordDto,
} from '@storageos/shared';
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileUp,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';
import { EditKeywordDialog, SerpDialog } from '../sistrix/keywords-panel';
import { SeoOrigin } from '../sistrix/seo-origin';

import { TargetStatusBadge, shortUrl } from './diagnostic-bits';
import { KeywordCandidatesDialog } from './keyword-candidates-dialog';
import { KeywordDetailSheet } from './keyword-detail-sheet';
import { KeywordImportDialog } from './keyword-import-dialog';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import {
  type DiagnosticScope,
  downloadDiagnosticCsv,
  useTrackedKeywords,
} from '@/lib/seo-advanced/diagnostic-hooks';
import {
  useAddKeywords,
  useRemoveKeyword,
  useUpdateKeyword,
} from '@/lib/seo-advanced/sistrix-hooks';
import { cn } from '@/lib/utils';

const ALL = 'all';
type View = 'list' | 'intent' | 'group';
type Sort = 'impressions' | 'clicks' | 'position' | 'change' | 'keyword';
const SORT_LABELS: Record<Sort, string> = {
  impressions: 'Más impresiones',
  clicks: 'Más clics',
  position: 'Mejor posición',
  change: 'Más suben',
  keyword: 'Alfabético',
};

/** La palabra en la forma que usan los diálogos de edición de la PR 3. */
function asProjectKeyword(k: SeoTrackedKeywordDto): SeoProjectKeywordDto {
  return {
    id: k.id,
    keyword: k.keyword,
    country: '',
    groupName: k.groupName,
    intent: k.manualIntent,
    targetUrl: k.targetUrl,
    priority: k.priority,
    notes: k.notes,
    strategyLocked: k.strategyLocked,
    source: k.source,
    isActive: k.isActive,
    createdAt: k.createdAt,
    masterImportedAt: k.masterImportedAt,
    metrics: null,
    serp: null,
  };
}

function Change({ diff }: { diff: number | null }) {
  if (diff === null || diff === 0) return null;
  const up = diff > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs',
        up ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
      )}
      title={up ? 'Sube frente al periodo anterior' : 'Baja frente al periodo anterior'}
    >
      {up ? (
        <ArrowUp className="size-3" aria-hidden />
      ) : (
        <ArrowDown className="size-3" aria-hidden />
      )}
      {formatNumber(Math.abs(diff), 1)}
    </span>
  );
}

function GroupTable({ rows, title }: { rows: SeoTrackedGroupDto[]; title: string }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[480px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{title}</th>
            <th className="px-3 py-2 text-right font-medium">Palabras</th>
            <th className="px-3 py-2 text-right font-medium">Clics</th>
            <th className="px-3 py-2 text-right font-medium">Impresiones</th>
            <th className="px-3 py-2 text-right font-medium">CTR</th>
            <th className="px-3 py-2 text-right font-medium">Posición media</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((g) => (
            <tr key={g.key}>
              <td className="px-3 py-2">{g.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(g.keywords)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(g.clicks)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(g.impressions)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {g.ctr === null ? '—' : formatPct(g.ctr * 100)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {g.position === null ? '—' : formatNumber(g.position, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Palabras seguidas del proyecto (una sola vista: la de la PR 3 ampliada):
 * alta a mano, desde Search Console o desde un CSV/Excel; su posición, clics e
 * impresiones del periodo con la variación; URL objetivo frente a la que
 * enseña Google; volumen de SISTRIX (estimación); intención y grupo, con la
 * vista agrupada; filtros, orden, CSV y su ficha día a día.
 */
export function TrackedKeywordsPanel({
  scope,
  canEdit,
  domains,
}: {
  scope: DiagnosticScope;
  canEdit: boolean;
  domains: SeoProjectDomainDto[];
}) {
  const confirm = useConfirm();
  const ownDomains = domains.filter((d) => d.role !== 'redirect');
  const [days, setDays] = useState(28);
  const [domainId, setDomainId] = useState<string | null>(null);
  const data = useTrackedKeywords(scope, { days, domainId });
  const add = useAddKeywords(scope);
  const update = useUpdateKeyword(scope);
  const remove = useRemoveKeyword(scope);
  const [view, setView] = useState<View>('list');
  const [sort, setSort] = useState<Sort>('impressions');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState(ALL);
  const [intent, setIntent] = useState(ALL);
  const [target, setTarget] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [serpOf, setSerpOf] = useState<SeoProjectKeywordDto | null>(null);
  const [editing, setEditing] = useState<SeoProjectKeywordDto | null>(null);
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const items = data.data?.items;
  const groups = useMemo(
    () => [...new Set((items ?? []).map((k) => k.groupName ?? SEO_NO_GROUP))].sort(),
    [items],
  );
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (items ?? []).filter(
      (k) =>
        (!q || k.keyword.toLowerCase().includes(q)) &&
        (group === ALL || (k.groupName ?? SEO_NO_GROUP) === group) &&
        (intent === ALL || (k.intent ?? SEO_NO_INTENT) === intent) &&
        (target === ALL || k.targetStatus === target) &&
        (priority === ALL || String(k.priority) === priority),
    );
    const pos = (n: number | null) => n ?? Number.POSITIVE_INFINITY;
    return [...list].sort((a, b) => {
      switch (sort) {
        case 'clicks':
          return b.clicks - a.clicks || b.impressions - a.impressions;
        case 'position':
          return pos(a.position) - pos(b.position);
        case 'change':
          return (b.positionDiff ?? -Infinity) - (a.positionDiff ?? -Infinity);
        case 'keyword':
          return a.keyword.localeCompare(b.keyword);
        default:
          return b.impressions - a.impressions || b.clicks - a.clicks;
      }
    });
  }, [items, search, group, intent, target, priority, sort]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = text
      .split(/[\n,;]/)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2);
    if (list.length === 0) return;
    try {
      await add.mutateAsync({ keywords: list });
      setText('');
      toast.success(list.length === 1 ? 'Palabra añadida' : `${list.length} palabras añadidas`);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const del = async (k: SeoTrackedKeywordDto) => {
    const yes = await confirm({
      title: `¿Dejar de seguir «${k.keyword}»?`,
      description: 'Se pierden el grupo, la URL objetivo y las notas que le hayas puesto.',
      confirmLabel: 'Quitar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(k.id);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const acceptSuggestion = async (k: SeoTrackedKeywordDto) => {
    try {
      await update.mutateAsync({ id: k.id, targetUrl: k.suggestedUrl });
      toast.success('URL objetivo guardada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const csv = async () => {
    try {
      await downloadDiagnosticCsv(
        scope,
        'tracked-keywords',
        { days, domainId },
        'palabras-seguidas.csv',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const d = data.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEO_TRACKED_PERIODS.map((p) => (
              <SelectItem key={p} value={String(p)}>
                Últimos {p} días
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={view} onValueChange={(v) => setView(v as View)}>
          <SelectTrigger aria-label="Vista">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="list">Lista de palabras</SelectItem>
            <SelectItem value="intent">Por intención</SelectItem>
            <SelectItem value="group">Por grupo</SelectItem>
          </SelectContent>
        </Select>
        {ownDomains.length > 1 ? (
          <Select value={domainId ?? ALL} onValueChange={(v) => setDomainId(v === ALL ? null : v)}>
            <SelectTrigger aria-label="Dominio">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Dominio principal</SelectItem>
              {ownDomains.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Button variant="outline" onClick={() => void csv()} disabled={!d?.items.length}>
            <Download className="mr-1 size-4" aria-hidden /> Descargar CSV
          </Button>
        )}
      </div>

      {d && (
        <p className="text-xs text-muted-foreground">
          {d.domain ?? 'Sin dominio'} · Search Console del {formatDate(d.from)} al{' '}
          {formatDate(d.to)}
          {d.comparable
            ? ' (variación frente a los días anteriores)'
            : ' (sin periodo anterior completo con el que comparar)'}{' '}
          · {formatCount(d.count)} de {formatCount(d.limit)} palabras
        </p>
      )}

      {d && d.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="URL objetivo">
          {SEO_TARGET_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setTarget(target === s ? ALL : s)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                target === s ? 'border-primary bg-primary/10' : 'hover:bg-muted',
              )}
              aria-pressed={target === s}
            >
              {SEO_TARGET_STATUS_LABELS[s]}{' '}
              <span className="font-semibold tabular-nums">{d.targetSummary[s]}</span>
            </button>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="space-y-2">
          <form onSubmit={(e) => void submit(e)} className="space-y-2">
            <Label htmlFor="tracked-new">Añadir palabras a mano (una por línea)</Label>
            <Textarea
              id="tracked-new"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder={'trasteros valencia\nguardamuebles mislata'}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={add.isPending || !text.trim()}>
                <Plus className="mr-1 size-4" aria-hidden /> Añadir
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setCandidatesOpen(true)}
              >
                <Search className="mr-1 size-4" aria-hidden /> Desde Search Console
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                <FileUp className="mr-1 size-4" aria-hidden /> Importar CSV o Excel
              </Button>
              {ownDomains.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void csv()}
                  disabled={!d?.items.length}
                >
                  <Download className="mr-1 size-4" aria-hidden /> Descargar CSV
                </Button>
              )}
            </div>
          </form>
        </div>
      )}

      {data.isError ? (
        <SectionError onRetry={() => void data.refetch()} />
      ) : data.isLoading || !d ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : d.items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Aún no sigues ninguna palabra. Añádelas a mano, desde las búsquedas reales de Search
          Console, desde un fichero o desde las ideas de SISTRIX y las oportunidades.
        </p>
      ) : view === 'intent' ? (
        <GroupTable rows={d.byIntent} title="Intención" />
      ) : view === 'group' ? (
        <GroupTable rows={d.byGroup} title="Grupo" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="relative lg:col-span-2">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar palabra"
                aria-label="Buscar palabra"
                className="pl-8"
              />
            </div>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger aria-label="Grupo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los grupos</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g || 'none'} value={g}>
                    {g || 'Sin grupo'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={intent} onValueChange={setIntent}>
              <SelectTrigger aria-label="Intención">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Cualquier intención</SelectItem>
                {(Object.keys(SEO_KEYWORD_INTENT_LABELS) as SeoKeywordIntent[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SEO_KEYWORD_INTENT_LABELS[k]}
                  </SelectItem>
                ))}
                <SelectItem value={SEO_NO_INTENT}>Sin decidir</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1 lg:grid-cols-1">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger aria-label="Prioridad">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Cualquier prioridad</SelectItem>
                  {[1, 2, 3].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      {SEO_KEYWORD_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger aria-label="Orden">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SORT_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Ninguna palabra con estos filtros.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((k) => (
                <li key={k.id} className={cn('space-y-1.5 p-3', !k.isActive && 'opacity-60')}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setOpen(k.id)}
                          className="break-words text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                        >
                          {k.keyword}
                        </button>
                        <Badge variant="outline" className="font-normal">
                          {SEO_KEYWORD_PRIORITY_LABELS[k.priority]}
                        </Badge>
                        {k.groupName && (
                          <Badge variant="secondary" className="font-normal">
                            {k.groupName}
                          </Badge>
                        )}
                        <TargetStatusBadge status={k.targetStatus as SeoTargetStatus} />
                        {k.strategyLocked && (
                          <Lock
                            className="size-3.5 text-muted-foreground"
                            aria-label="Decisión fijada"
                          />
                        )}
                      </div>
                      {k.intent && (
                        <p className="text-xs text-muted-foreground">
                          {SEO_KEYWORD_INTENT_LABELS[k.intent]}
                          {k.intentSource ? ` (${SEO_INTENT_SOURCE_LABELS[k.intentSource]})` : ''}
                        </p>
                      )}
                      {k.masterImportedAt && (
                        <p className="text-xs text-muted-foreground">
                          {seoMasterOriginLabel(k.masterImportedAt)}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSerpOf(asProjectKeyword(k))}
                      >
                        Ver Google
                      </Button>
                      {canEdit && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Editar ${k.keyword}`}
                            onClick={() => setEditing(asProjectKeyword(k))}
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Quitar ${k.keyword}`}
                            onClick={() => void del(k)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span>
                      Posición {k.position === null ? '—' : formatNumber(k.position, 1)}{' '}
                      <Change diff={k.positionDiff} />
                    </span>
                    <span>{formatCount(k.clicks)} clics</span>
                    <span>{formatCount(k.impressions)} impresiones</span>
                    <span>CTR {k.ctr === null ? '—' : formatPct(k.ctr * 100)}</span>
                    {k.volume !== null && k.volumeOrigin && (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        Volumen {formatCount(k.volume)} (estimación)
                        <SeoOrigin origin={k.volumeOrigin} />
                      </span>
                    )}
                  </div>
                  <div className="grid gap-0.5 text-xs sm:grid-cols-2">
                    <span className="min-w-0 break-all">
                      <span className="text-muted-foreground">URL objetivo: </span>
                      {shortUrl(k.targetUrl)}
                    </span>
                    <span className="min-w-0 break-all">
                      <span className="text-muted-foreground">Google enseña: </span>
                      {shortUrl(k.googlePage)}
                    </span>
                  </div>
                  {canEdit && k.suggestedUrl && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="min-w-0 break-all text-muted-foreground">
                        Propuesta (la que más clics lleva): {shortUrl(k.suggestedUrl)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={update.isPending}
                        onClick={() => void acceptSuggestion(k)}
                      >
                        Usar como URL objetivo
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <KeywordDetailSheet
        scope={scope}
        id={open}
        days={90}
        domainId={domainId}
        onClose={() => setOpen(null)}
      />
      <SerpDialog scope={scope} keyword={serpOf} onClose={() => setSerpOf(null)} />
      <EditKeywordDialog
        keyword={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => update.mutateAsync({ id: editing!.id, ...input })}
      />
      {canEdit && (
        <>
          <KeywordCandidatesDialog
            scope={scope}
            open={candidatesOpen}
            onOpenChange={setCandidatesOpen}
            domainId={domainId}
          />
          <KeywordImportDialog scope={scope} open={importOpen} onOpenChange={setImportOpen} />
        </>
      )}
    </div>
  );
}
