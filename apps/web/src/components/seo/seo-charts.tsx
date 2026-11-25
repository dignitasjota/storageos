'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { SeoDashboardDayDto, SeoShareRow } from '@storageos/shared';

import { formatCount, formatNumber, formatPct, formatShortDay } from '@/lib/format';

/** Colores de la pareja validada (ver `globals.css`): este periodo y el de comparación. */
const CURRENT = 'var(--seo-current)';
const PREVIOUS = 'var(--seo-previous)';

export const DEVICE_LABELS: Record<string, string> = {
  MOBILE: 'Móvil',
  DESKTOP: 'Ordenador',
  TABLET: 'Tableta',
};

export const SEARCH_TYPE_LABELS: Record<string, string> = {
  web: 'Web',
  image: 'Imágenes',
  video: 'Vídeos',
  news: 'Noticias',
};

/** Países de Search Console (códigos de tres letras). Los demás, con su código. */
const COUNTRY_LABELS: Record<string, string> = {
  esp: 'España',
  fra: 'Francia',
  prt: 'Portugal',
  gbr: 'Reino Unido',
  deu: 'Alemania',
  ita: 'Italia',
  nld: 'Países Bajos',
  bel: 'Bélgica',
  che: 'Suiza',
  irl: 'Irlanda',
  usa: 'Estados Unidos',
  mex: 'México',
  arg: 'Argentina',
  col: 'Colombia',
  chl: 'Chile',
  per: 'Perú',
  ven: 'Venezuela',
  ecu: 'Ecuador',
  mar: 'Marruecos',
  rou: 'Rumanía',
  and: 'Andorra',
  zzz: 'Desconocido',
};
export const countryLabel = (code: string) => COUNTRY_LABELS[code] ?? code.toUpperCase();

type Metric = 'clicks' | 'impressions' | 'ctr' | 'position';

const formatters: Record<Metric, (n: number) => string> = {
  clicks: (n) => formatCount(n),
  impressions: (n) => formatCount(n),
  ctr: (n) => formatPct(n, 1),
  position: (n) => formatNumber(n, 1),
};

/**
 * Evolución diaria de UNA medida, con un solo eje. Clics e impresiones llevan
 * además el periodo de comparación (línea discontinua, con leyenda); el CTR y
 * la posición, una sola línea (el título la nombra). La posición va con el eje
 * al revés: arriba es mejor.
 */
export function SeoTrendChart({
  title,
  metric,
  days,
  compare,
}: {
  title: string;
  metric: Metric;
  days: SeoDashboardDayDto[];
  /** Con la línea del periodo anterior (solo clics e impresiones). */
  compare: boolean;
}) {
  const withPrevious = compare && (metric === 'clicks' || metric === 'impressions');
  const data = days.map((d) => ({
    date: d.date,
    source: d.source,
    value:
      metric === 'ctr'
        ? d.ctr === null
          ? null
          : d.ctr * 100
        : metric === 'position'
          ? d.position
          : d[metric],
    previous:
      metric === 'clicks'
        ? d.previousClicks
        : metric === 'impressions'
          ? d.previousImpressions
          : null,
  }));
  const fmt = formatters[metric];
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div className="h-48" role="img" aria-label={`${title}, día a día`}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 320, height: 192 }}
        >
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.4} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatShortDay(d)}
              tick={{ fontSize: 11 }}
              minTickGap={28}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              width={44}
              allowDecimals={metric !== 'clicks' && metric !== 'impressions'}
              reversed={metric === 'position'}
              domain={metric === 'position' ? [1, 'auto'] : [0, 'auto']}
              tickFormatter={(n: number) => (metric === 'ctr' ? `${formatNumber(n, 0)} %` : fmt(n))}
            />
            <Tooltip
              labelFormatter={(label, payload) => {
                const row = payload?.[0]?.payload as { source?: string } | undefined;
                return `${formatShortDay(String(label))}${row?.source === 'import' ? ' · importado' : ''}`;
              }}
              formatter={(value, name) => [
                value == null ? '—' : fmt(Number(value)),
                name === 'previous' ? 'Periodo anterior' : 'Este periodo',
              ]}
            />
            {withPrevious && (
              <Legend
                verticalAlign="top"
                height={24}
                iconType="plainline"
                formatter={(value) => (value === 'previous' ? 'Periodo anterior' : 'Este periodo')}
              />
            )}
            <Line
              dataKey="value"
              name="value"
              stroke={CURRENT}
              strokeWidth={2}
              dot={false}
              connectNulls={metric === 'position' || metric === 'ctr'}
              isAnimationActive={false}
            />
            {withPrevious && (
              <Line
                dataKey="previous"
                name="previous"
                stroke={PREVIOUS}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Reparto por dispositivo, país o tipo de búsqueda: barras con su parte de los clics. */
export function SeoShareList({
  title,
  rows,
  label,
  rest,
}: {
  title: string;
  rows: SeoShareRow[];
  label: (key: string) => string;
  rest?: (SeoShareRow & { count: number }) | null;
}) {
  const all = rest ? [...rows, rest] : rows;
  const max = Math.max(1, ...all.map((r) => r.totals.clicks));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {all.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin datos en el periodo.</p>
      ) : (
        <ul className="space-y-2">
          {all.map((r) => {
            const isRest = rest && r === rest;
            return (
              <li key={r.key} className="space-y-1 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {isRest ? `Resto (${rest.count})` : label(r.key)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCount(r.totals.clicks)} clics
                    {r.clickShare !== null && ` · ${formatPct(r.clickShare * 100, 0)}`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, (r.totals.clicks / max) * 100)}%`,
                      backgroundColor: CURRENT,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatCount(r.totals.impressions)} impresiones · posición{' '}
                  {r.totals.position === null ? '—' : formatNumber(r.totals.position, 1)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
