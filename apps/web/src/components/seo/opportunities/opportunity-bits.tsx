'use client';

import {
  SEO_OPPORTUNITY_STATUS_LABELS,
  SEO_OPPORTUNITY_TYPE_LABELS,
  type SeoOpportunityStatus,
  type SeoOpportunityType,
  type SeoScoredOpportunityDto,
} from '@storageos/shared';

import { SeoOrigin } from '../sistrix/seo-origin';

import { Badge } from '@/components/ui/badge';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Puntuación con su barra (0–100). */
export function OpportunityScore({ score, className }: { score: number; className?: string }) {
  const tone =
    score >= 70
      ? 'bg-emerald-600 dark:bg-emerald-500'
      : score >= 40
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-slate-400 dark:bg-slate-500';
  return (
    <div className={cn('w-14 shrink-0 space-y-1 text-center', className)}>
      <span className="block text-lg font-semibold tabular-nums leading-none">{score}</span>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label={`Puntuación ${score} de 100`}
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

const TYPE_TONE: Record<SeoOpportunityType, string> = {
  near_top3: 'border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-300',
  near_page1: 'border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-300',
  commercial_deep: 'border-sky-300 text-sky-800 dark:border-sky-700 dark:text-sky-300',
  low_ctr: 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300',
  rising: 'border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-300',
  falling: 'border-red-300 text-red-800 dark:border-red-700 dark:text-red-300',
  demand_gap: 'border-violet-300 text-violet-800 dark:border-violet-700 dark:text-violet-300',
  sistrix: 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-300',
  keyword_gap: 'border-sky-300 text-sky-800 dark:border-sky-700 dark:text-sky-300',
};

export function OpportunityTypeBadge({ type }: { type: SeoOpportunityType }) {
  return (
    <Badge variant="outline" className={cn('font-normal', TYPE_TONE[type])}>
      {SEO_OPPORTUNITY_TYPE_LABELS[type]}
    </Badge>
  );
}

export function OpportunityStatusBadge({
  status,
  returned,
}: {
  status: SeoOpportunityStatus;
  returned?: boolean;
}) {
  return (
    <>
      <Badge variant={status === 'new' ? 'default' : 'secondary'} className="font-normal">
        {SEO_OPPORTUNITY_STATUS_LABELS[status]}
      </Badge>
      {returned && status === 'new' && (
        <Badge
          variant="outline"
          className="border-amber-300 font-normal text-amber-800 dark:border-amber-700 dark:text-amber-300"
        >
          Ha vuelto
        </Badge>
      )}
    </>
  );
}

/** Las cifras que la justifican, en una línea: de Google o de SISTRIX según el caso. */
export function OpportunityFigures({ o }: { o: SeoScoredOpportunityDto }) {
  const g = o.metrics.gsc;
  const s = o.metrics.sistrix;
  const parts: string[] = [];
  const pos = g?.position ?? s?.position ?? null;
  if (pos !== null) parts.push(`Posición ${formatNumber(pos, 1)}`);
  if (g) {
    parts.push(`${formatCount(g.impressions)} impresiones`);
    parts.push(`${formatCount(g.clicks)} clics`);
    if (g.ctr !== null) parts.push(`CTR ${formatPct(g.ctr * 100)}`);
  }
  if (s?.volume != null) parts.push(`Volumen ${formatCount(s.volume)}/mes`);
  if (o.metrics.competitors?.[0]) {
    const c = o.metrics.competitors[0];
    parts.push(`${c.domain} en la ${c.position}`);
  }
  return <span>{parts.join(' · ')}</span>;
}

/** De dónde salen los datos y de qué fecha son. */
export function OpportunityOrigins({ o }: { o: SeoScoredOpportunityDto }) {
  const g = o.metrics.gsc;
  const s = o.metrics.sistrix;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {g && (
        <span className="text-xs text-muted-foreground">
          Search Console (datos reales) · {formatDate(g.from)}–{formatDate(g.to)}
        </span>
      )}
      {s && <SeoOrigin origin={s} />}
      {!s && o.metrics.competitorsOrigin && <SeoOrigin origin={o.metrics.competitorsOrigin} />}
    </span>
  );
}
