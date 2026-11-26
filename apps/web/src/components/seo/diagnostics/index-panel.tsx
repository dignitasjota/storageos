'use client';

import {
  SEO_INDEX_CATEGORIES,
  SEO_INDEX_CATEGORY_LABELS,
  SEO_INDEX_EVIDENCE_LABELS,
  SEO_INDEX_EVIDENCE_NOTE,
  type SeoDiagnosticStatus,
  type SeoIndexFindingDto,
} from '@storageos/shared';
import { Download, Info, Loader2, Map as MapIcon, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ChangeDialog, type ChangeDraft, type TaskDraft } from '../plan/plan-dialogs';
import { SeoPlanLinks } from '../plan/plan-links';
import { seoErrorMessage } from '../seo-errors';
import { InspectUrlButton, SeoIndexStatusBadge } from '../technical/inspection-bits';

import { DIAGNOSTIC_STATUS_OPTIONS } from './cannibalization-panel';
import { DiagnosticManage, DiagnosticStatusBadge, shortUrl } from './diagnostic-bits';
import { useDebounced } from './use-debounced';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatDateTime } from '@/lib/format';
import {
  type DiagnosticScope,
  downloadDiagnosticCsv,
  useIndexFindings,
  useIndexSummary,
  useSitemaps,
  useUpdateDiagnostic,
} from '@/lib/seo-advanced/diagnostic-hooks';

const ALL = 'all';

/**
 * De dónde sale el hallazgo y lo que dice Google de la URL: «aparece en el
 * rendimiento» (reglas) o la inspección de URL, y su última inspección.
 */
function EvidenceBadges({ f }: { f: SeoIndexFindingDto }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge variant="outline" className="font-normal">
        {SEO_INDEX_EVIDENCE_LABELS[f.evidence]}
      </Badge>
      <SeoIndexStatusBadge status={f.inspection} />
    </span>
  );
}

/** Lo que se lleva al plan desde un hallazgo de indexación. */
function findingDrafts(f: SeoIndexFindingDto): { task: TaskDraft; change: ChangeDraft } {
  const title =
    f.category === 'not_indexed'
      ? `Que Google indexe ${shortUrl(f.url)}`
      : f.category === 'canonical_mismatch'
        ? `Revisar la canónica de ${shortUrl(f.url)}`
        : `Sacar de Google ${shortUrl(f.url)}`;
  const type =
    f.category === 'redirect_domain'
      ? 'redirect'
      : f.evidence === 'inspection'
        ? 'technical'
        : 'noindex';
  return {
    task: { title, type: 'technical', url: f.url, keywords: [], indexFindingId: f.id },
    change: { title, type, urls: [f.url], keywords: [], indexFindingId: f.id },
  };
}

function Detail({
  scope,
  f,
  canEdit,
  busy,
  onSave,
}: {
  scope: DiagnosticScope;
  f: SeoIndexFindingDto;
  canEdit: boolean;
  busy: boolean;
  onSave: (input: { status?: SeoDiagnosticStatus; notes?: string | null }) => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-normal">
          {SEO_INDEX_CATEGORY_LABELS[f.category]}
        </Badge>
        <DiagnosticStatusBadge status={f.status} returned={!!f.returnedAt} />
        {!f.active && <Badge variant="secondary">Ya no sale</Badge>}
      </div>
      <p>{f.reason}</p>
      <EvidenceBadges f={f} />
      <InspectUrlButton scope={scope} url={f.url} canEdit={canEdit} />
      <p className="text-xs text-muted-foreground">{SEO_INDEX_EVIDENCE_NOTE}</p>
      <section className="space-y-1">
        <h3 className="font-medium">Qué hacer</h3>
        <p>{f.action}</p>
      </section>
      <DiagnosticManage
        status={f.status}
        notes={f.notes}
        canEdit={canEdit}
        busy={busy}
        onSave={onSave}
      />
      <SeoPlanLinks
        scope={scope}
        canEdit={canEdit}
        resolved={f.status === 'fixed'}
        {...findingDrafts(f)}
      />
      <p className="text-xs text-muted-foreground">
        Detectada el {formatDate(f.detectedAt)} · último cálculo {formatDateTime(f.lastSeenAt)}
      </p>
    </div>
  );
}

function Sitemaps({ scope }: { scope: DiagnosticScope }) {
  const [shown, setShown] = useState(false);
  const maps = useSitemaps(scope, shown);
  if (!shown) {
    return (
      <Button variant="outline" size="sm" onClick={() => setShown(true)}>
        <MapIcon className="mr-1 size-4" aria-hidden /> Ver los mapas del sitio enviados a Google
      </Button>
    );
  }
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Mapas del sitio en Search Console</h3>
      <p className="text-xs text-muted-foreground">
        Lo que dice Google de cada mapa (URL enviadas, avisos y errores). No se descarga el
        contenido de cada mapa: para saber qué páginas tiene Google llega más adelante la inspección
        de URL.
      </p>
      {maps.isError ? (
        <SectionError onRetry={() => void maps.refetch()} />
      ) : maps.isLoading || !maps.data ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {maps.data.domains.map((d) => (
            <li key={d.domainId} className="space-y-1 p-3">
              <span className="font-medium">{d.domain}</span>
              {d.error ? (
                <p className="text-xs text-muted-foreground">{d.error}</p>
              ) : d.sitemaps.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hay mapas del sitio enviados.</p>
              ) : (
                d.sitemaps.map((m) => (
                  <div key={m.path} className="text-xs">
                    <span className="break-all">{m.path}</span>
                    <span className="block tabular-nums text-muted-foreground">
                      {formatCount(m.submitted)} URL enviadas · {formatCount(m.warnings)} avisos ·{' '}
                      {formatCount(m.errors)} errores
                      {m.lastDownloaded
                        ? ` · leído por Google el ${formatDate(m.lastDownloaded)}`
                        : ''}
                      {m.matchesRule ? ` · casa con la regla «${m.matchesRule}»` : ''}
                    </span>
                  </div>
                ))
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Páginas que aparecen en Google y no deberían, según las reglas del proyecto. */
export function IndexPanel({ scope, canEdit }: { scope: DiagnosticScope; canEdit: boolean }) {
  const [status, setStatus] = useState('open');
  const [category, setCategory] = useState(ALL);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText);
  const statuses = DIAGNOSTIC_STATUS_OPTIONS.find((o) => o.value === status)!.statuses;
  const filters = { statuses, category: category === ALL ? null : category, search };
  const summary = useIndexSummary(scope);
  const list = useIndexFindings(scope, filters);
  const update = useUpdateDiagnostic(scope, 'index');
  const [openId, setOpenId] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const open = items.find((f) => f.id === openId) ?? null;

  const [recording, setRecording] = useState<ChangeDraft | null>(null);
  const save = async (
    id: string,
    input: { status?: SeoDiagnosticStatus; notes?: string | null },
  ) => {
    const item = items.find((f) => f.id === id);
    try {
      await update.mutateAsync({ id, input });
      // Al darla por arreglada, se ofrece registrar el cambio (opcional).
      if (input.status === 'fixed' && item && canEdit) {
        toast.success('Arreglada', {
          description: '¿Registras el cambio para ver su antes y después?',
          action: {
            label: 'Registrar la actuación',
            onClick: () => setRecording(findingDrafts(item).change),
          },
          duration: 10_000,
        });
        return;
      }
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const csv = async () => {
    try {
      await downloadDiagnosticCsv(
        scope,
        'index-findings',
        { status: statuses.join(','), category: filters.category, search },
        'indexacion.csv',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const s = summary.data;
  const withFindings = s ? SEO_INDEX_CATEGORIES.filter((c) => s.byCategory[c] > 0) : [];
  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-md border bg-muted/30 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p>
          Páginas que <strong>aparecen en el rendimiento de Search Console</strong> (han tenido
          impresiones) y casan con tus reglas de lo que no debería estar en Google, más variantes
          duplicadas de una misma página y lo que sale por un dominio que debería redirigir. Y lo
          que dice la <strong>inspección de URL de Google</strong>: URL objetivo que no tiene
          indexadas y páginas para las que eligió otra canónica. {SEO_INDEX_EVIDENCE_NOTE}
        </p>
      </div>

      {s && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-sm">
            <span className="font-semibold tabular-nums">{formatCount(s.open)}</span> pendientes
          </span>
          {withFindings.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(category === c ? ALL : c)}
              aria-pressed={category === c}
              className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
            >
              {SEO_INDEX_CATEGORY_LABELS[c]}{' '}
              <span className="font-semibold tabular-nums">{s.byCategory[c]}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Buscar URL"
            aria-label="Buscar URL"
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIAGNOSTIC_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void csv()} disabled={items.length === 0}>
          <Download className="mr-1 size-4" aria-hidden /> CSV
        </Button>
      </div>

      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {list.data?.calculatedAt
            ? 'Ninguna página con estos filtros.'
            : 'Aún no se ha calculado: se hace tras cada descarga de Search Console.'}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((f) => (
            <li key={f.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="font-normal">
                  {SEO_INDEX_CATEGORY_LABELS[f.category]}
                </Badge>
                <DiagnosticStatusBadge status={f.status} returned={!!f.returnedAt} />
                <SeoIndexStatusBadge status={f.inspection} />
              </div>
              <button
                type="button"
                onClick={() => setOpenId(f.id)}
                className="block max-w-full break-all text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {f.url}
              </button>
              <p className="text-xs tabular-nums text-muted-foreground">
                {f.evidence === 'inspection'
                  ? `Inspección de URL de Google del ${formatDate(f.lastDate)}`
                  : `${formatCount(f.impressions)} impresiones · ${formatCount(f.clicks)} clics · del ${formatDate(f.firstDate)} al ${formatDate(f.lastDate)} · regla «${f.rule}»`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {list.data?.calculatedAt && (
        <p className="text-xs text-muted-foreground">
          Calculado el {formatDateTime(list.data.calculatedAt)} con datos de Search Console.
        </p>
      )}

      <Sitemaps scope={scope} />

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-6">{open?.url}</DialogTitle>
            <DialogDescription>{open?.domain}</DialogDescription>
          </DialogHeader>
          {open && (
            <Detail
              scope={scope}
              f={open}
              canEdit={canEdit}
              busy={update.isPending}
              onSave={(input) => void save(open.id, input)}
            />
          )}
        </DialogContent>
      </Dialog>
      <ChangeDialog
        scope={scope}
        domains={[]}
        open={recording !== null}
        onOpenChange={(v) => !v && setRecording(null)}
        draft={recording}
      />
    </div>
  );
}
