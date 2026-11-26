'use client';

import {
  SEO_INTENT_SOURCE_LABELS,
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_SOURCE_LABELS,
  type SeoChartMarkerDto,
  type SeoDashboardDayDto,
  type SeoTrackedKeywordDetailDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';

import { DEVICE_LABELS, SeoTrendChart, countryLabel } from '../seo-charts';
import { SeoOrigin } from '../sistrix/seo-origin';

import { TargetStatusBadge, shortUrl } from './diagnostic-bits';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import { type DiagnosticScope, useTrackedKeywordDetail } from '@/lib/seo-advanced/diagnostic-hooks';
import { useChangeMarkers } from '@/lib/seo-advanced/plan-hooks';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function MetricRows({
  rows,
  label,
}: {
  rows: {
    key: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  }[];
  label: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin datos.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[420px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{label}</th>
            <th className="px-3 py-2 text-right font-medium">Clics</th>
            <th className="px-3 py-2 text-right font-medium">Impresiones</th>
            <th className="px-3 py-2 text-right font-medium">CTR</th>
            <th className="px-3 py-2 text-right font-medium">Posición</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="max-w-[16rem] break-all px-3 py-2">{r.key}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(r.clicks)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(r.impressions)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.ctr === null ? '—' : formatPct(r.ctr * 100)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.position === null ? '—' : formatNumber(r.position, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Body({ d, markers }: { d: SeoTrackedKeywordDetailDto; markers: SeoChartMarkerDto[] }) {
  const k = d.keyword;
  const days: SeoDashboardDayDto[] = d.daily.map((x) => ({
    date: x.date,
    clicks: x.clicks,
    impressions: x.impressions,
    ctr: x.ctr,
    position: x.position,
    source: 'api',
    previousClicks: null,
    previousImpressions: null,
  }));
  const sistrixDays: SeoDashboardDayDto[] = d.sistrix.points.map((p) => ({
    date: p.date,
    clicks: 0,
    impressions: 0,
    ctr: null,
    position: p.position,
    source: 'api',
    previousClicks: null,
    previousImpressions: null,
  }));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1.5">
        <TargetStatusBadge status={k.targetStatus} />
        {k.groupName && <Badge variant="secondary">{k.groupName}</Badge>}
        {k.intent && (
          <Badge variant="outline" className="font-normal">
            {SEO_KEYWORD_INTENT_LABELS[k.intent]}
            {k.intentSource ? ` · ${SEO_INTENT_SOURCE_LABELS[k.intentSource]}` : ''}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Añadida {SEO_KEYWORD_SOURCE_LABELS[k.source].toLowerCase()} el {formatDate(k.createdAt)}
        </span>
      </div>

      <Section title="URL objetivo frente a la que enseña Google">
        <div className="space-y-1 text-sm">
          <p className="break-all">
            <span className="text-muted-foreground">URL objetivo: </span>
            {k.targetUrl ?? 'sin decidir'}
          </p>
          <p className="break-all">
            <span className="text-muted-foreground">Google enseña sobre todo: </span>
            {k.googlePage ?? 'ninguna en el periodo'}
            {k.topShare !== null && ` (${formatPct(k.topShare * 100, 0)} de las impresiones)`}
          </p>
          {k.suggestedUrl && (
            <p className="break-all text-muted-foreground">
              Propuesta: {k.suggestedUrl} (la que más clics lleva).
            </p>
          )}
        </div>
      </Section>

      {days.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Esta búsqueda no ha tenido impresiones en Search Console del {formatDate(d.from)} al{' '}
          {formatDate(d.to)}.
        </p>
      ) : (
        <Section
          title={`Día a día en Search Console (${formatDate(d.from)} – ${formatDate(d.to)})`}
        >
          <div className="grid gap-4">
            <SeoTrendChart
              title="Posición media"
              metric="position"
              days={days}
              compare={false}
              markers={markers}
            />
            <SeoTrendChart
              title="Clics"
              metric="clicks"
              days={days}
              compare={false}
              markers={markers}
            />
            <SeoTrendChart
              title="Impresiones"
              metric="impressions"
              days={days}
              compare={false}
              markers={markers}
            />
            <SeoTrendChart title="CTR" metric="ctr" days={days} compare={false} markers={markers} />
          </div>
        </Section>
      )}

      <Section title="Cambios de la página que enseña Google">
        {d.pageChanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Google ha enseñado siempre la misma página en este periodo.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.pageChanges.map((c) => (
              <li key={c.date} className="break-all">
                <span className="tabular-nums text-muted-foreground">{formatDate(c.date)}:</span>{' '}
                {shortUrl(c.from)} → <span className="font-medium">{shortUrl(c.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Por página">
        <MetricRows
          label="Página"
          rows={d.pages.map((p) => ({
            ...p,
            key: `${shortUrl(p.page)}${p.isTarget ? ' (objetivo)' : ''} · ${formatPct(p.share * 100, 0)}`,
          }))}
        />
      </Section>
      <Section title="Por dispositivo">
        <MetricRows
          label="Dispositivo"
          rows={d.devices.map((r) => ({ ...r, key: DEVICE_LABELS[r.device] ?? r.device }))}
        />
      </Section>
      <Section title="Por país (10 primeros)">
        <MetricRows
          label="País"
          rows={d.countries.map((r) => ({ ...r, key: countryLabel(r.country) }))}
        />
      </Section>

      <Section title="Posición según SISTRIX (estimación)">
        {sistrixDays.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            SISTRIX no tiene posición de tu web para esta palabra (o aún no se ha pedido).
          </p>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Posición nacional de su muestra, no la de tu ciudad: sirve de referencia, no sustituye
              a Search Console.
            </p>
            {d.sistrix.origin && <SeoOrigin origin={d.sistrix.origin} />}
            {sistrixDays.length > 1 ? (
              <SeoTrendChart
                title="Posición estimada (SISTRIX)"
                metric="position"
                days={sistrixDays}
                compare={false}
              />
            ) : (
              <p className="text-sm tabular-nums">
                {formatDate(d.sistrix.points[0]!.date)}: posición {d.sistrix.points[0]!.position}
              </p>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

/** Ficha de una palabra seguida: evolución, páginas, dispositivos, países y SISTRIX aparte. */
export function KeywordDetailSheet({
  scope,
  id,
  days,
  domainId,
  onClose,
}: {
  scope: DiagnosticScope;
  id: string | null;
  days: number;
  domainId: string | null;
  onClose: () => void;
}) {
  const detail = useTrackedKeywordDetail(scope, id, { days, domainId });
  const k = detail.data;
  // Las actuaciones que tocan esta palabra o su URL objetivo (y las de todo el sitio).
  const markers = useChangeMarkers(
    scope,
    {
      domainId,
      from: k?.from ?? null,
      to: k?.to ?? null,
      query: k?.keyword.keyword ?? null,
      url: k?.keyword.targetUrl ?? null,
    },
    !!k,
  );
  return (
    <Sheet open={id !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-words pr-6">
            {detail.data?.keyword.keyword ?? 'Palabra'}
          </SheetTitle>
          <SheetDescription>{detail.data?.domain ?? ' '}</SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {detail.isError ? (
            <SectionError onRetry={() => void detail.refetch()} />
          ) : detail.isLoading || !detail.data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Body d={detail.data} markers={markers.data ?? []} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
