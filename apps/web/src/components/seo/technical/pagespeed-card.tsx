'use client';

import {
  SEO_CWV_HELP,
  SEO_CWV_RATING_LABELS,
  SEO_FIELD_CATEGORY_LABELS,
  SEO_PAGESPEED_STRATEGY_LABELS,
  seoCwvRating,
  seoScoreRating,
  type SeoCwvMetric,
  type SeoCwvRating,
  type SeoFieldCategory,
  type SeoPageSpeedRunDto,
  type SeoPageSpeedStrategy,
} from '@storageos/shared';
import { Gauge, Info, Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatDateTime, formatNumber, formatShortDay } from '@/lib/format';
import {
  type TechnicalScope,
  usePageSpeedHistory,
  useRunPageSpeed,
  useSeoPageSpeed,
} from '@/lib/seo-advanced/technical-hooks';
import { cn } from '@/lib/utils';

/** Color de la serie (el mismo que «este periodo» en los gráficos del panel). */
const SERIES = 'var(--seo-current)';

const RATING_STYLE: Record<SeoCwvRating, string> = {
  good: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  needs_improvement:
    'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  poor: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};
const FIELD_RATING: Record<SeoFieldCategory, SeoCwvRating | null> = {
  FAST: 'good',
  AVERAGE: 'needs_improvement',
  SLOW: 'poor',
  NONE: null,
};

const seconds = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${formatNumber(ms, 0)} ms` : `${formatNumber(ms / 1000, 1)} s`;
const clsText = (v: number | null) => (v === null ? '—' : formatNumber(v, 2));

function ScoreChip({ score, label }: { score: number | null; label: string }) {
  const r = seoScoreRating(score);
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 font-normal tabular-nums',
        r ? RATING_STYLE[r] : 'text-muted-foreground',
      )}
      title={r ? SEO_CWV_RATING_LABELS[r] : 'Sin medir'}
    >
      {label} {score ?? '—'}
    </Badge>
  );
}

function FieldChip({ run }: { run: SeoPageSpeedRunDto | null }) {
  const f = run?.field;
  if (!run || run.status !== 'done') return null;
  if (!f || !f.overall) {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Usuarios reales: sin datos suficientes
      </Badge>
    );
  }
  const r = FIELD_RATING[f.overall];
  return (
    <Badge variant="outline" className={cn('font-normal', r ? RATING_STYLE[r] : '')}>
      Usuarios reales: {SEO_FIELD_CATEGORY_LABELS[f.overall]}
      {f.scope === 'origin' && ' (todo el sitio)'}
    </Badge>
  );
}

/**
 * «Velocidad»: PageSpeed Insights de las páginas importantes, en móvil y en
 * ordenador, con lo que ven los usuarios reales (Core Web Vitals) y lo que mide
 * el laboratorio, su evolución y las mejoras sugeridas.
 */
export function SeoPageSpeedCard({ scope, canEdit }: { scope: TechnicalScope; canEdit: boolean }) {
  const q = useSeoPageSpeed(scope);
  const run = useRunPageSpeed(scope);
  const [url, setUrl] = useState('');
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    try {
      await run.mutateAsync({ url: url.trim() });
      toast.success('Medición en marcha: tarda entre 10 y 30 segundos por versión');
      setUrl('');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const data = q.data;
  return (
    <Card id="velocidad" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Velocidad</CardTitle>
        <CardDescription>
          Lo rápido que carga cada página según PageSpeed Insights de Google, en el móvil y en el
          ordenador.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          {(['lcp', 'inp', 'cls'] as SeoCwvMetric[]).map((m) => (
            <li key={m}>{SEO_CWV_HELP[m]}</li>
          ))}
          <li className="text-xs text-muted-foreground">
            «Usuarios reales» son datos de Chrome de los últimos 28 días (si la página tiene
            bastantes visitas; si no, los de todo el sitio). El laboratorio es una carga simulada:
            sirve para ver qué mejorar.
          </li>
        </ul>

        {canEdit && (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://tuweb.es/pagina o /pagina"
              aria-label="URL que medir"
              className="min-w-0"
            />
            <Button type="submit" disabled={run.isPending || !url.trim()}>
              {run.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <Gauge className="mr-1 size-4" aria-hidden />
              )}
              Medir
            </Button>
          </form>
        )}

        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : q.isLoading || !data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {scope.kind === 'admin' && !data.keyConfigured && canEdit && (
              <p className="flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                Sin clave de PageSpeed (`PAGESPEED_API_KEY`) Google deja muy pocas mediciones y
                algunas fallarán. La clave es gratuita.
              </p>
            )}
            {data.pending > 0 && (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {data.pending} medición(es) en marcha.
              </p>
            )}
            {data.urls.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Aún no se ha medido ninguna página.
                {data.settings.pagespeedEnabled &&
                  ' Cada lunes se miden solas la portada y las páginas más importantes.'}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.urls.map((u) => (
                  <li key={u.url} className="space-y-1.5 p-3">
                    <button
                      type="button"
                      onClick={() => setOpenUrl(u.url)}
                      className="block max-w-full break-all text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                      {u.url}
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ScoreChip
                        label="Móvil"
                        score={u.mobile?.status === 'done' ? u.mobile.scores.performance : null}
                      />
                      <ScoreChip
                        label="Ordenador"
                        score={u.desktop?.status === 'done' ? u.desktop.scores.performance : null}
                      />
                      <FieldChip run={u.mobile} />
                      {[u.mobile, u.desktop].some((r) => r?.status === 'error') && (
                        <Badge
                          variant="outline"
                          className="font-normal text-red-700 dark:text-red-300"
                        >
                          Falló una medición
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {u.mobile?.analyzedAt
                        ? `Medida el ${formatDateTime(u.mobile.analyzedAt)}`
                        : 'Pendiente de medir'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Origen: PageSpeed Insights de Google (Lighthouse y datos de Chrome).
              {data.lastScheduledAt &&
                ` Última medición semanal: ${formatDateTime(data.lastScheduledAt)}.`}
            </p>
          </>
        )}
      </CardContent>
      <PageSpeedDetail scope={scope} url={openUrl} onClose={() => setOpenUrl(null)} />
    </Card>
  );
}

function MetricRow({
  label,
  value,
  rating,
  help,
}: {
  label: string;
  value: string;
  rating: SeoCwvRating | null;
  help?: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5" title={help}>
      <span>{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="tabular-nums">{value}</span>
        {rating && (
          <Badge variant="outline" className={cn('font-normal', RATING_STYLE[rating])}>
            {SEO_CWV_RATING_LABELS[rating]}
          </Badge>
        )}
      </span>
    </li>
  );
}

/** Un gráfico de una sola métrica (un solo eje), con su unidad. */
function TrendChart({
  title,
  points,
  unit,
  domain,
}: {
  title: string;
  points: { date: string; value: number | null }[];
  unit: string;
  domain?: [number, number];
}) {
  if (points.filter((p) => p.value !== null).length < 2) return null;
  return (
    <figure className="space-y-1">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatShortDay(d)}
              tick={{ fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis tick={{ fontSize: 11 }} width={44} domain={domain ?? ['auto', 'auto']} />
            <Tooltip
              labelFormatter={(d) => formatShortDay(String(d))}
              formatter={(v) => [`${formatNumber(Number(v), unit === 's' ? 1 : 0)} ${unit}`, title]}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={SERIES}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function PageSpeedDetail({
  scope,
  url,
  onClose,
}: {
  scope: TechnicalScope;
  url: string | null;
  onClose: () => void;
}) {
  const [strategy, setStrategy] = useState<SeoPageSpeedStrategy>('mobile');
  const h = usePageSpeedHistory(scope, url, strategy);
  const runs = h.data?.runs ?? [];
  const last = runs[runs.length - 1] ?? null;
  const day = (r: SeoPageSpeedRunDto) => (r.analyzedAt ?? r.createdAt).slice(0, 10);
  return (
    <Dialog open={!!url} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all pr-6">{url}</DialogTitle>
          <DialogDescription>Velocidad según PageSpeed Insights</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5" role="group" aria-label="Versión">
          {(['mobile', 'desktop'] as SeoPageSpeedStrategy[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStrategy(s)}
              aria-pressed={strategy === s}
              className="rounded-full border px-3 py-1 text-sm hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
            >
              {SEO_PAGESPEED_STRATEGY_LABELS[s]}
            </button>
          ))}
        </div>
        {h.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : !last ? (
          <p className="text-sm text-muted-foreground">Aún no hay mediciones de esta versión.</p>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap gap-1.5">
              <ScoreChip label="Rendimiento" score={last.scores.performance} />
              <ScoreChip label="SEO" score={last.scores.seo} />
              <ScoreChip label="Accesibilidad" score={last.scores.accessibility} />
              <ScoreChip label="Buenas prácticas" score={last.scores.bestPractices} />
            </div>

            <section className="space-y-1">
              <h3 className="font-medium">Usuarios reales (Core Web Vitals)</h3>
              {last.field ? (
                <>
                  <ul className="divide-y">
                    <MetricRow
                      label="LCP: lo principal tarda en verse"
                      value={seconds(last.field.lcpMs)}
                      rating={seoCwvRating('lcp', last.field.lcpMs)}
                      help={SEO_CWV_HELP.lcp}
                    />
                    <MetricRow
                      label="INP: tarda en reaccionar"
                      value={seconds(last.field.inpMs)}
                      rating={seoCwvRating('inp', last.field.inpMs)}
                      help={SEO_CWV_HELP.inp}
                    />
                    <MetricRow
                      label="CLS: las cosas se mueven"
                      value={clsText(last.field.cls)}
                      rating={seoCwvRating('cls', last.field.cls)}
                      help={SEO_CWV_HELP.cls}
                    />
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    {last.field.scope === 'url'
                      ? 'De esta página.'
                      : 'De todo el sitio: esta página no tiene bastantes visitas para tener sus propios datos.'}{' '}
                    Chrome, últimos 28 días.
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Google no tiene bastantes visitas de usuarios reales de esta página ni del sitio.
                </p>
              )}
            </section>

            <section className="space-y-1">
              <h3 className="font-medium">Laboratorio (carga simulada)</h3>
              <ul className="divide-y">
                <MetricRow
                  label="LCP"
                  value={seconds(last.lab.lcpMs)}
                  rating={seoCwvRating('lcp', last.lab.lcpMs)}
                />
                <MetricRow
                  label="TBT (bloqueo)"
                  value={seconds(last.lab.tbtMs)}
                  rating={seoCwvRating('tbt', last.lab.tbtMs)}
                />
                <MetricRow
                  label="CLS"
                  value={clsText(last.lab.cls)}
                  rating={seoCwvRating('cls', last.lab.cls)}
                />
                <MetricRow
                  label="FCP (primer contenido)"
                  value={seconds(last.lab.fcpMs)}
                  rating={seoCwvRating('fcp', last.lab.fcpMs)}
                />
                <MetricRow
                  label="Speed Index"
                  value={seconds(last.lab.siMs)}
                  rating={seoCwvRating('si', last.lab.siMs)}
                />
                <MetricRow
                  label="TTI (se puede usar)"
                  value={seconds(last.lab.ttiMs)}
                  rating={seoCwvRating('tti', last.lab.ttiMs)}
                />
              </ul>
            </section>

            <TrendChart
              title="Puntuación de rendimiento (de 0 a 100)"
              unit="puntos"
              domain={[0, 100]}
              points={runs.map((r) => ({ date: day(r), value: r.scores.performance }))}
            />
            <TrendChart
              title="LCP del laboratorio (segundos)"
              unit="s"
              points={runs.map((r) => ({
                date: day(r),
                value: r.lab.lcpMs === null ? null : r.lab.lcpMs / 1000,
              }))}
            />

            {last.opportunities.length > 0 && (
              <section className="space-y-1">
                <h3 className="font-medium">Qué mejorar</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {last.opportunities.map((o) => (
                    <li key={o.id}>
                      {o.title}
                      {o.savingsMs !== null && (
                        <span className="text-muted-foreground">
                          {' '}
                          · podría ahorrar unos {seconds(o.savingsMs)}
                        </span>
                      )}
                      {o.displayValue && (
                        <span className="text-muted-foreground"> · {o.displayValue}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="text-xs text-muted-foreground">
              Origen: PageSpeed Insights, medida el{' '}
              {formatDateTime(last.analyzedAt ?? last.createdAt)} ({runs.length} medición(es)
              guardada(s)).
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
