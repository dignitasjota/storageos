'use client';

import {
  SEO_PANEL_PERIOD_LABELS,
  type SeoGa4MetricsDto,
  type SeoPagePerformanceSort,
  type SeoPanelPeriod,
} from '@storageos/shared';
import { Info, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import { type Ga4AiScope, useSeoGa4Page, useSeoGa4Pages } from '@/lib/seo-advanced/ga4-ai-hooks';

const PERIODS: SeoPanelPeriod[] = ['7d', '28d', '90d', '6m', '12m'];
const SORTS: { id: SeoPagePerformanceSort; label: string }[] = [
  { id: 'clicks', label: 'Más clics en Google' },
  { id: 'sessions', label: 'Más sesiones' },
  { id: 'engagement', label: 'Mucho tráfico y poca interacción' },
  { id: 'conversions', label: 'Más conversiones' },
];

const pct = (r: number | null | undefined) => (r == null ? '—' : formatPct(r * 100, 1));
const pos = (p: number | null | undefined) => (p == null ? '—' : formatNumber(p, 1));
const count = (n: number | null | undefined) => (n == null ? '—' : formatCount(n));

/** «1 min 35 s» (o «—»). */
export function formatSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m} min ${r} s` : `${r} s`;
}

/** Por qué Search Console y GA4 no cuadran (se dice siempre). */
export function Ga4SourcesNote() {
  return (
    <p className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Search Console cuenta clics en Google; Google Analytics, sesiones en tu web. No son lo mismo
        (un clic puede no llegar a ser una sesión) y GA4 solo cuenta a quien acepta las cookies de
        analítica, así que sus cifras suelen ser más bajas. Las conversiones son las de TrasterOS.
      </span>
    </p>
  );
}

/**
 * Rendimiento por página de entrada (PR 12): Search Console (clics,
 * impresiones y posición), Google Analytics (sesiones, interacción, duración
 * y eventos clave) y las conversiones propias desde Google.
 */
export function SeoGa4PagesCard({ scope }: { scope: Ga4AiScope }) {
  const [period, setPeriod] = useState<SeoPanelPeriod>('28d');
  const [sort, setSort] = useState<SeoPagePerformanceSort>('clicks');
  const q = useSeoGa4Pages(scope, { period, sort });
  const d = q.data;

  return (
    <Card id="paginas-ga4" className="scroll-mt-20">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle>Páginas: Google, Analytics y conversiones</CardTitle>
          <CardDescription>
            Cada página por la que entra la gente desde Google, con lo que dicen Search Console,
            Google Analytics y las conversiones propias.
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select value={sort} onValueChange={(v) => setSort(v as SeoPagePerformanceSort)}>
            <SelectTrigger className="h-9 w-full sm:w-[250px]" aria-label="Orden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={period} onValueChange={(v) => setPeriod(v as SeoPanelPeriod)}>
            <SelectTrigger className="h-9 w-[150px]" aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {SEO_PANEL_PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {!d.connected && (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Google Analytics no está conectado: conéctalo en «Ajustes» para ver las sesiones y
                la interacción de cada página. Mientras, salen Search Console y las conversiones.
              </p>
            )}
            <Ga4SourcesNote />
            <p className="text-xs text-muted-foreground">
              Del {formatDate(d.from)} al {formatDate(d.to)}
              {d.gscUntil || d.ga4Until
                ? ` (últimos datos: Search Console ${d.gscUntil ? formatDate(d.gscUntil) : '—'}, Analytics ${d.ga4Until ? formatDate(d.ga4Until) : '—'})`
                : ''}
              . Los clics de aquí suman los de las páginas de entrada: pueden no coincidir con el
              total del resumen del proyecto (que cuenta todo el sitio). Si Google Analytics aplica
              umbrales de privacidad, faltarán sesiones.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Clics de Google" value={formatCount(d.totals.gscClicks)} />
              <Figure label="Sesiones (Analytics)" value={count(d.totals.ga4?.sessions)} />
              <Figure label="Con interacción" value={pct(d.totals.ga4?.engagementRate)} />
              <Figure label="Conversiones" value={formatCount(d.totals.conversions)} />
            </div>
            {d.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aún no hay datos en este periodo.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Página</th>
                      <th className="px-3 py-2 text-right font-medium">Clics</th>
                      <th className="px-3 py-2 text-right font-medium">Impresiones</th>
                      <th className="px-3 py-2 text-right font-medium">Posición</th>
                      <th className="px-3 py-2 text-right font-medium">Sesiones</th>
                      <th className="px-3 py-2 text-right font-medium">Interacción</th>
                      <th className="px-3 py-2 text-right font-medium">Duración media</th>
                      <th className="px-3 py-2 text-right font-medium">Eventos clave</th>
                      <th className="px-3 py-2 text-right font-medium">Conversiones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((r) => (
                      <tr key={r.landing || 'none'} className="border-t">
                        <td className="max-w-[260px] truncate px-3 py-2 font-mono text-xs">
                          {r.landing || (
                            <span className="font-sans text-muted-foreground">No se sabe</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {count(r.gsc?.clicks)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {count(r.gsc?.impressions)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {pos(r.gsc?.position)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {count(r.ga4?.sessions)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <EngagementValue m={r.ga4} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatSeconds(r.ga4?.averageSessionDuration)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.ga4 ? formatNumber(r.ga4.keyEvents, 0) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCount(r.conversions)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** La interacción, marcada si hay mucho tráfico y poca interacción. */
function EngagementValue({ m }: { m: SeoGa4MetricsDto | null }) {
  if (!m || m.engagementRate === null) return <>—</>;
  const low = m.sessions >= 50 && m.engagementRate < 0.4;
  return (
    <span className={low ? 'font-medium text-amber-700 dark:text-amber-400' : undefined}>
      {pct(m.engagementRate)}
    </span>
  );
}

/**
 * Las cifras de GA4 de una página (en la ficha de una palabra o de una
 * página). No sale nada si el proyecto no tiene GA4 conectado.
 */
export function SeoGa4PageFigures({
  scope,
  url,
  days = 90,
}: {
  scope: Ga4AiScope;
  url: string | null;
  days?: number;
}) {
  const q = useSeoGa4Page(scope, url, days);
  const d = q.data;
  if (!url || !d?.connected) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <h4 className="flex flex-wrap items-center gap-2 text-sm font-medium">
        Google Analytics <Badge variant="outline">Visitas desde Google</Badge>
      </h4>
      {d.metrics ? (
        <>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{d.landing || '/'}</span> del {formatDate(d.from)} al{' '}
            {formatDate(d.to)}.
          </p>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Sesiones</dt>
              <dd className="tabular-nums">{formatCount(d.metrics.sessions)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Con interacción</dt>
              <dd className="tabular-nums">{pct(d.metrics.engagementRate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Duración media</dt>
              <dd className="tabular-nums">{formatSeconds(d.metrics.averageSessionDuration)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Eventos clave</dt>
              <dd className="tabular-nums">{formatNumber(d.metrics.keyEvents, 0)}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            GA4 solo cuenta a quien acepta las cookies; un clic en Google no es siempre una sesión.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Google Analytics no tiene visitas desde Google a esta página en ese tiempo.
        </p>
      )}
    </div>
  );
}
