'use client';

import {
  SEO_INTENT_SOURCE_LABELS,
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  SEO_OPPORTUNITY_SOURCE_LABELS,
  SEO_OPPORTUNITY_STATUSES,
  SEO_OPPORTUNITY_STATUS_LABELS,
  type SeoDashboardDayDto,
  type SeoOpportunityDetailDto,
  type SeoOpportunityStatus,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SeoTrendChart } from '../seo-charts';
import { seoErrorMessage } from '../seo-errors';
import { SeoOrigin } from '../sistrix/seo-origin';

import {
  OpportunityOrigins,
  OpportunityScore,
  OpportunityStatusBadge,
  OpportunityTypeBadge,
} from './opportunity-bits';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { Textarea } from '@/components/ui/textarea';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import {
  type OpportunityScope,
  useOpportunityAssignees,
  useOpportunityDetail,
  useUpdateOpportunity,
} from '@/lib/seo-advanced/opportunity-hooks';
import { cn } from '@/lib/utils';

const UNASSIGNED = '__none__';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Ficha de una oportunidad: por qué (la puntuación desglosada en palabras),
 * sus datos con su origen y fecha, su evolución, qué hacer y su gestión.
 */
export function OpportunityDetailSheet({
  scope,
  id,
  canEdit,
  onClose,
  onDismiss,
}: {
  scope: OpportunityScope;
  id: string | null;
  canEdit: boolean;
  onClose: () => void;
  onDismiss: (id: string, query: string) => void;
}) {
  const detail = useOpportunityDetail(scope, id);
  const update = useUpdateOpportunity(scope);
  const assignees = useOpportunityAssignees(scope, canEdit && !!id);
  const [notes, setNotes] = useState('');
  const o = detail.data;

  useEffect(() => {
    setNotes(o?.notes ?? '');
  }, [o?.id, o?.notes]);

  // Al abrir una nueva, pasa a «vista» (solo quien puede cambiarla).
  const { mutate } = update;
  useEffect(() => {
    if (canEdit && o && o.status === 'new') mutate({ id: o.id, input: { status: 'seen' } });
  }, [canEdit, o, mutate]);

  const save = async (input: Parameters<typeof update.mutateAsync>[0]['input'], ok: string) => {
    if (!o) return;
    try {
      await update.mutateAsync({ id: o.id, input });
      toast.success(ok);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Sheet open={id !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-words pr-6">{o?.query ?? 'Oportunidad'}</SheetTitle>
          <SheetDescription>
            {o ? `${o.domain} · detectada el ${formatDate(o.detectedAt)}` : ' '}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-6">
          {detail.isError ? (
            <SectionError onRetry={() => void detail.refetch()} />
          ) : detail.isLoading || !o ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Body o={o} />
          )}

          {o && canEdit && (
            <Section title="Gestión">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="opp-status">Estado</Label>
                  <Select
                    value={o.status}
                    onValueChange={(v) => {
                      const status = v as SeoOpportunityStatus;
                      if (status === 'dismissed') onDismiss(o.id, o.query);
                      else void save({ status }, 'Estado cambiado');
                    }}
                  >
                    <SelectTrigger id="opp-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEO_OPPORTUNITY_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {SEO_OPPORTUNITY_STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="opp-assignee">Quién la lleva</Label>
                  <Select
                    value={o.assignedToId ?? UNASSIGNED}
                    onValueChange={(v) =>
                      void save(
                        { assignedToId: v === UNASSIGNED ? null : v },
                        v === UNASSIGNED ? 'Sin asignar' : 'Asignada',
                      )
                    }
                  >
                    <SelectTrigger id="opp-assignee">
                      <SelectValue placeholder="Sin asignar" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>Sin asignar</SelectItem>
                      {(assignees.data ?? []).map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                      {o.assignedToId && !assignees.data?.some((a) => a.id === o.assignedToId) && (
                        <SelectItem value={o.assignedToId}>
                          {o.assignedToName ?? 'Otra persona'}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {o.status === 'dismissed' && o.dismissReason && (
                <p className="text-sm text-muted-foreground">Descartada: {o.dismissReason}</p>
              )}
              <div className="space-y-1">
                <Label htmlFor="opp-notes">Notas</Label>
                <Textarea
                  id="opp-notes"
                  value={notes}
                  maxLength={2000}
                  rows={3}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Qué se ha hecho o qué falta"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending || notes === (o.notes ?? '')}
                    onClick={() => void save({ notes: notes.trim() || null }, 'Notas guardadas')}
                  >
                    Guardar notas
                  </Button>
                </div>
              </div>
            </Section>
          )}
          {o && !canEdit && (o.notes || o.assignedToName) && (
            <Section title="Gestión">
              {o.assignedToName && <Row label="Quién la lleva">{o.assignedToName}</Row>}
              {o.notes && <p className="whitespace-pre-wrap text-sm">{o.notes}</p>}
            </Section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Body({ o }: { o: SeoOpportunityDetailDto }) {
  const g = o.metrics.gsc;
  const s = o.metrics.sistrix;
  const days: SeoDashboardDayDto[] = o.daily.map((d) => ({
    date: d.date,
    clicks: d.clicks,
    impressions: d.impressions,
    ctr: d.ctr,
    position: d.position,
    source: 'api',
    previousClicks: null,
    previousImpressions: null,
  }));
  return (
    <>
      <div className="flex items-start gap-4">
        <OpportunityScore score={o.score} />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <OpportunityTypeBadge type={o.type} />
            <OpportunityStatusBadge status={o.status} returned={!!o.returnedAt} />
            {!o.active && (
              <Badge variant="outline" className="font-normal">
                Ya no se cumple
              </Badge>
            )}
          </div>
          <p className="text-sm">{o.reason}</p>
          <OpportunityOrigins o={o} />
        </div>
      </div>

      <Section title="Qué hacer">
        <p className="rounded-md bg-muted/60 p-3 text-sm">{o.action}</p>
        {(o.page || o.targetUrl) && (
          <div className="space-y-1">
            {o.page && <Row label="Página que sale">{o.page}</Row>}
            {o.targetUrl && <Row label="URL objetivo">{o.targetUrl}</Row>}
          </div>
        )}
      </Section>

      <Section title={`Por qué tiene ${o.score} puntos`}>
        <ul className="space-y-2">
          {o.factors.map((f) => (
            <li key={f.key} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className={cn(f.value === null && 'text-muted-foreground')}>
                  {f.label}
                  <span className="ml-1 text-xs text-muted-foreground">
                    (peso {formatNumber(f.weight * 100, 0)} %)
                  </span>
                </span>
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    f.points < 0 && 'text-red-700 dark:text-red-400',
                    f.points === 0 && 'text-muted-foreground',
                  )}
                >
                  {f.points > 0 ? '+' : ''}
                  {formatNumber(f.points, 1)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{f.detail}</p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Confianza del dato: {formatPct(o.confidence * 100, 0)} (más con datos reales de Google que
          solo con estimaciones de SISTRIX). Lo que no se sabe no resta: su peso se reparte entre lo
          demás.
        </p>
      </Section>

      {g && (
        <Section title="Search Console (datos reales)">
          <Row label="Periodo">
            {formatDate(g.from)} – {formatDate(g.to)}
          </Row>
          <Row label="Impresiones">{formatCount(g.impressions)}</Row>
          <Row label="Clics">{formatCount(g.clicks)}</Row>
          <Row label="CTR">
            {g.ctr === null ? '—' : formatPct(g.ctr * 100)}
            {g.expectedCtr !== null && ` (esperado ${formatPct(g.expectedCtr * 100)})`}
          </Row>
          <Row label="Posición media">
            {g.position === null ? '—' : formatNumber(g.position, 1)}
          </Row>
          {g.previous ? (
            <Row label={`Antes (${formatDate(g.previous.from)} – ${formatDate(g.previous.to)})`}>
              {formatCount(g.previous.impressions)} impresiones · posición{' '}
              {g.previous.position === null ? '—' : formatNumber(g.previous.position, 1)}
            </Row>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sin periodo anterior comparable (faltan datos de esos días).
            </p>
          )}
        </Section>
      )}

      {days.length > 0 && (
        <Section title="Evolución en Google (90 días)">
          <SeoTrendChart title="Impresiones" metric="impressions" days={days} compare={false} />
          <SeoTrendChart title="Posición media" metric="position" days={days} compare={false} />
        </Section>
      )}

      {o.pages.length > 0 && (
        <Section title="Sus páginas en el periodo">
          <ul className="divide-y text-sm">
            {o.pages.map((p) => (
              <li key={p.page} className="space-y-0.5 py-2">
                <p className="break-all">{p.page}</p>
                <p className="text-xs text-muted-foreground">
                  {formatCount(p.clicks)} clics · {formatCount(p.impressions)} impresiones ·
                  posición {p.position === null ? '—' : formatNumber(p.position, 1)}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(s || o.metrics.intent || o.metrics.inCatalog) && (
        <Section title="Búsqueda">
          {o.metrics.intent && (
            <Row label="Intención">
              {SEO_KEYWORD_INTENT_LABELS[o.metrics.intent.value]} (
              {SEO_INTENT_SOURCE_LABELS[o.metrics.intent.source]})
            </Row>
          )}
          {o.metrics.inCatalog && o.metrics.priority !== null && (
            <Row label="Prioridad en tus palabras">
              {SEO_KEYWORD_PRIORITY_LABELS[o.metrics.priority] ?? o.metrics.priority}
            </Row>
          )}
          {s && (
            <>
              <Row label="Volumen (SISTRIX)">
                {s.volume === null ? 'Sin dato' : `${formatCount(s.volume)} al mes`}
              </Row>
              {s.competition !== null && <Row label="Competencia">{s.competition}/100</Row>}
              {s.position !== null && <Row label="Posición según SISTRIX">{s.position}</Row>}
              {s.gain !== null && <Row label="Visitas que estima ganar">{formatCount(s.gain)}</Row>}
              <SeoOrigin origin={s} />
            </>
          )}
          {o.metrics.impressionShare !== null && (
            <p className="text-xs text-muted-foreground">
              Impresiones reales frente a volumen: {formatPct(o.metrics.impressionShare * 100)}. El
              volumen de SISTRIX es nacional y la impresión solo cuenta cuando apareces: no es una
              cuota de mercado exacta.
            </p>
          )}
        </Section>
      )}

      {o.metrics.competitors && o.metrics.competitors.length > 0 && (
        <Section title="Competidores que salen">
          <ul className="divide-y text-sm">
            {o.metrics.competitors.map((c) => (
              <li key={c.domain} className="flex justify-between gap-3 py-1.5">
                <span className="min-w-0 break-all">{c.url || c.domain}</span>
                <span className="shrink-0 tabular-nums">Posición {c.position}</span>
              </li>
            ))}
          </ul>
          {o.metrics.competitorsOrigin && <SeoOrigin origin={o.metrics.competitorsOrigin} />}
        </Section>
      )}

      {o.serp && (
        <Section title="Resultados de Google">
          <ol className="divide-y text-sm">
            {o.serp.results.map((r) => (
              <li key={`${r.position}-${r.url}`} className="flex gap-3 py-1.5">
                <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                  {r.position}
                </span>
                <span className="min-w-0 break-all">
                  {r.domain}
                  {r.own && (
                    <Badge variant="secondary" className="ml-2 font-normal">
                      Tú
                    </Badge>
                  )}
                  {r.competitor && (
                    <Badge variant="outline" className="ml-2 font-normal">
                      Competidor
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ol>
          <SeoOrigin origin={o.serp.origin} />
        </Section>
      )}

      <p className="text-xs text-muted-foreground">
        Orígenes: {o.sources.map((x) => SEO_OPPORTUNITY_SOURCE_LABELS[x]).join(' y ')}. Vista por
        última vez el {formatDate(o.lastSeenAt)}.
      </p>
    </>
  );
}
