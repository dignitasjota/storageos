'use client';

import {
  SEO_CANNIBALIZATION_KIND_LABELS,
  SEO_DIAGNOSTIC_OPEN_STATUSES,
  SEO_SEVERITIES,
  SEO_SEVERITY_LABELS,
  sameSeoUrl,
  type SeoCannibalizationDto,
  type SeoDiagnosticStatus,
} from '@storageos/shared';
import { Download, Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import {
  DiagnosticManage,
  DiagnosticStatusBadge,
  SeverityBadge,
  shortUrl,
} from './diagnostic-bits';
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
import { formatCount, formatDate, formatDateTime, formatNumber, formatPct } from '@/lib/format';
import {
  type DiagnosticScope,
  downloadDiagnosticCsv,
  useCannibalizationSummary,
  useCannibalizations,
  useUpdateDiagnostic,
} from '@/lib/seo-advanced/diagnostic-hooks';

const ALL = 'all';
export const DIAGNOSTIC_STATUS_OPTIONS: {
  value: string;
  label: string;
  statuses: SeoDiagnosticStatus[];
}[] = [
  { value: 'open', label: 'Pendientes', statuses: SEO_DIAGNOSTIC_OPEN_STATUSES },
  { value: 'fixed', label: 'Arregladas', statuses: ['fixed'] },
  { value: 'ok', label: 'Correctas', statuses: ['ok'] },
  { value: ALL, label: 'Todas', statuses: ['new', 'reviewed', 'fixed', 'ok'] },
];

/** La página que gana cada día, en tramos («del 3 al 9: /precios»). */
function segments(timeline: { date: string; page: string }[]) {
  const out: { from: string; to: string; page: string }[] = [];
  for (const t of timeline) {
    const last = out[out.length - 1];
    if (last && sameSeoUrl(last.page, t.page)) last.to = t.date;
    else out.push({ from: t.date, to: t.date, page: t.page });
  }
  return out;
}

function Detail({
  c,
  canEdit,
  busy,
  onSave,
}: {
  c: SeoCannibalizationDto;
  canEdit: boolean;
  busy: boolean;
  onSave: (input: { status?: SeoDiagnosticStatus; notes?: string | null }) => void;
}) {
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={c.severity} />
        <Badge variant="outline" className="font-normal">
          {SEO_CANNIBALIZATION_KIND_LABELS[c.kind]}
        </Badge>
        <DiagnosticStatusBadge status={c.status} returned={!!c.returnedAt} />
        {!c.active && <Badge variant="secondary">Ya no sale</Badge>}
      </div>
      <p>{c.reason}</p>
      <section className="space-y-2">
        <h3 className="font-medium">Páginas que se reparten la búsqueda</h3>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[480px]">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Página</th>
                <th className="px-3 py-2 text-right font-medium">Impresiones</th>
                <th className="px-3 py-2 text-right font-medium">Clics</th>
                <th className="px-3 py-2 text-right font-medium">Posición</th>
                <th className="px-3 py-2 text-right font-medium">Días ganando</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {c.pages.map((p) => (
                <tr key={p.page}>
                  <td className="max-w-[16rem] break-all px-3 py-2">
                    {shortUrl(p.page)}
                    {p.isTarget && (
                      <Badge variant="secondary" className="ml-1">
                        Objetivo
                      </Badge>
                    )}
                    {p.isHome && (
                      <Badge variant="outline" className="ml-1">
                        Portada
                      </Badge>
                    )}
                    {p.variants.length > 1 && (
                      <span className="block text-xs text-muted-foreground">
                        {p.variants.length} variantes de la misma URL, juntas
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(p.impressions)} ({formatPct(p.impressionsShare * 100, 0)})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCount(p.clicks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.position === null ? '—' : formatNumber(p.position, 1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.daysOnTop}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Search Console, del {formatDate(c.period.from)} al {formatDate(c.period.to)} (cruce
          búsqueda + página).
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Qué página ganó cada día</h3>
        <p className="text-xs text-muted-foreground">
          {c.switches === 0
            ? 'Siempre la misma.'
            : `Ha cambiado ${c.switches} ${c.switches === 1 ? 'vez' : 'veces'}.`}
        </p>
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {segments(c.timeline).map((s) => (
            <li key={s.from} className="break-all">
              <span className="tabular-nums text-muted-foreground">
                {s.from === s.to
                  ? formatDate(s.from)
                  : `${formatDate(s.from)} – ${formatDate(s.to)}`}
                :
              </span>{' '}
              {shortUrl(s.page)}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">Qué hacer</h3>
        <p>{c.action}</p>
        {!c.targetUrl && c.suggestedUrl && (
          <p className="break-all text-xs text-muted-foreground">
            Si sigues esta búsqueda en «Palabras seguidas», ponle como URL objetivo{' '}
            {shortUrl(c.suggestedUrl)}.
          </p>
        )}
      </section>
      <DiagnosticManage
        status={c.status}
        notes={c.notes}
        canEdit={canEdit}
        busy={busy}
        okLabel="Está bien así"
        onSave={onSave}
      />
      <p className="text-xs text-muted-foreground">
        Detectada el {formatDate(c.detectedAt)} · último cálculo {formatDateTime(c.lastSeenAt)}
      </p>
    </div>
  );
}

/** Búsquedas en las que dos o más páginas tuyas compiten, con su gravedad y qué hacer. */
export function CannibalizationPanel({
  scope,
  canEdit,
}: {
  scope: DiagnosticScope;
  canEdit: boolean;
}) {
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState(ALL);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText);
  const statuses = DIAGNOSTIC_STATUS_OPTIONS.find((o) => o.value === status)!.statuses;
  const filters = { statuses, severity: severity === ALL ? null : severity, search };
  const summary = useCannibalizationSummary(scope);
  const list = useCannibalizations(scope, filters);
  const update = useUpdateDiagnostic(scope, 'cannibalization');
  const [openId, setOpenId] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const open = items.find((c) => c.id === openId) ?? null;

  const save = async (
    id: string,
    input: { status?: SeoDiagnosticStatus; notes?: string | null },
  ) => {
    try {
      await update.mutateAsync({ id, input });
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const csv = async () => {
    try {
      await downloadDiagnosticCsv(
        scope,
        'cannibalization',
        { status: statuses.join(','), severity: filters.severity, search },
        'canibalizacion.csv',
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const s = summary.data;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Búsquedas en las que dos o más páginas de tu web se reparten las impresiones o se van
        turnando. No siempre es un error: la ficha dice por qué se marca y qué hacer. Fuera las
        búsquedas de tu marca y las variantes de una misma URL.
      </p>
      {s && (
        <div className="grid grid-cols-3 gap-2">
          {SEO_SEVERITIES.map((sev) => (
            <button
              key={sev}
              type="button"
              onClick={() => setSeverity(severity === sev ? ALL : sev)}
              aria-pressed={severity === sev}
              className="rounded-md border p-3 text-left hover:bg-muted/50 aria-pressed:border-primary aria-pressed:bg-primary/5"
            >
              <span className="block text-2xl font-semibold tabular-nums">
                {formatCount(s.bySeverity[sev])}
              </span>
              <span className="text-xs text-muted-foreground">
                Gravedad {SEO_SEVERITY_LABELS[sev].toLowerCase()}
              </span>
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
            placeholder="Buscar búsqueda"
            aria-label="Buscar búsqueda"
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
            ? 'No hay búsquedas canibalizadas con estos filtros.'
            : 'Aún no se ha calculado: se hace tras cada descarga de Search Console.'}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((c) => (
            <li key={c.id} className="space-y-1.5 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={c.severity} />
                <Badge variant="outline" className="font-normal">
                  {SEO_CANNIBALIZATION_KIND_LABELS[c.kind]}
                </Badge>
                <DiagnosticStatusBadge status={c.status} returned={!!c.returnedAt} />
              </div>
              <button
                type="button"
                onClick={() => setOpenId(c.id)}
                className="block max-w-full break-words text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {c.query}
              </button>
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatCount(c.totals.impressions)} impresiones · {formatCount(c.totals.clicks)}{' '}
                clics · {c.switches} cambios de página
              </p>
              <p className="break-all text-xs">
                {c.pages
                  .map((p) => `${shortUrl(p.page)} (${formatPct(p.impressionsShare * 100, 0)})`)
                  .join(' · ')}
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

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-words pr-6">{open?.query}</DialogTitle>
            <DialogDescription>{open?.domain}</DialogDescription>
          </DialogHeader>
          {open && (
            <Detail
              c={open}
              canEdit={canEdit}
              busy={update.isPending}
              onSave={(input) => void save(open.id, input)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
