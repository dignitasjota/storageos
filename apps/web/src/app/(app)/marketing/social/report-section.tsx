'use client';

import {
  SOCIAL_REPORT_DAYS,
  type SocialNetwork,
  type SocialNetworkReportDto,
  type SocialReportDto,
  type SocialTotals,
} from '@storageos/shared';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
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

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSocialReport } from '@/lib/marketing/hooks';

const int = (n: number) => n.toLocaleString('es-ES');

const NETWORK: Record<SocialNetwork, { label: string; color: string }> = {
  instagram: { label: 'Instagram', color: '#2563eb' },
  facebook: { label: 'Facebook', color: '#d97706' },
};

const WEEKDAY_NAMES = [
  'los domingos',
  'los lunes',
  'los martes',
  'los miércoles',
  'los jueves',
  'los viernes',
  'los sábados',
];

const FORMAT_LABELS: Record<string, string> = {
  IMAGE: 'Foto (Instagram)',
  VIDEO: 'Vídeo o reel (Instagram)',
  REELS: 'Reel (Instagram)',
  CAROUSEL_ALBUM: 'Carrusel (Instagram)',
  post: 'Publicación (Facebook)',
};

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** Variación frente al periodo anterior; null sin datos de antes. */
function delta(now: number, before: number): { text: string; className: string } | null {
  if (before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: '=', className: 'text-muted-foreground' };
  return {
    text: `${pct > 0 ? '+' : ''}${pct} %`,
    className:
      pct > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
  };
}

/** Cifras de una red. Las que Meta no da en esa red (0 en todo el periodo) no salen. */
function NetworkCard({ n, compare }: { n: SocialNetworkReportDto; compare: boolean }) {
  const metrics: { key: keyof SocialTotals; label: string }[] = [
    // La suma del alcance de cada día: una persona que vuelve otro día cuenta otra vez.
    { key: 'reach', label: 'Alcance (suma de cada día)' },
    { key: 'views', label: 'Visualizaciones' },
    { key: 'engagements', label: 'Interacciones' },
    { key: 'profileViews', label: 'Visitas al perfil' },
    { key: 'websiteClicks', label: 'Clics a tu web' },
  ];
  const shown = metrics.filter((m) => n.totals[m.key] > 0 || n.previous[m.key] > 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: NETWORK[n.network].color }}
            aria-hidden
          />
          {NETWORK[n.network].label}
        </CardTitle>
        <CardDescription>
          {n.followers != null ? (
            <>
              <span className="text-lg font-semibold text-foreground tabular-nums">
                {int(n.followers)}
              </span>{' '}
              seguidores
              {n.followersChange != null && n.followersChange !== 0 && (
                <span
                  className={
                    n.followersChange > 0
                      ? ' text-emerald-600 dark:text-emerald-400'
                      : ' text-red-600 dark:text-red-400'
                  }
                >
                  {' '}
                  ({n.followersChange > 0 ? '+' : ''}
                  {int(n.followersChange)})
                </span>
              )}
            </>
          ) : (
            'Seguidores: Meta aún no ha dado el dato.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin actividad en este periodo.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shown.map((m) => {
              // Sin datos de todo el periodo anterior (recién conectado) no se compara.
              const d = compare ? delta(n.totals[m.key], n.previous[m.key]) : null;
              return (
                <div key={m.key}>
                  <dt className="text-xs text-muted-foreground">{m.label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{int(n.totals[m.key])}</dd>
                  {d && <dd className={`text-xs ${d.className}`}>{d.text}</dd>}
                </div>
              );
            })}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ReachChart({ networks }: { networks: SocialNetworkReportDto[] }) {
  const byDate = new Map<string, Record<string, number | string | null>>();
  for (const n of networks) {
    for (const d of n.daily) {
      const row = byDate.get(d.date) ?? { date: d.date, label: dayLabel(d.date) };
      row[n.network] = d.reach;
      byDate.set(d.date, row);
    }
  }
  const points = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 300, height: 224 }}
      >
        <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'hsl(var(--foreground))' }}
            formatter={(value) => int(Number(value))}
          />
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => (
              <span style={{ color: 'hsl(var(--foreground))' }}>{String(value)}</span>
            )}
          />
          {networks.map((n) => (
            <Line
              key={n.network}
              type="monotone"
              dataKey={n.network}
              name={NETWORK[n.network].label}
              stroke={NETWORK[n.network].color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Report({ report }: { report: SocialReportDto }) {
  if (report.networks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay datos descargados. Pulsa «Actualizar» o espera a la descarga de mañana.
      </p>
    );
  }
  const pi = report.postInsights;
  return (
    <div className="space-y-4">
      {report.dataUntil && report.dataUntil < report.to && (
        <p className="text-xs text-muted-foreground">
          Meta da los datos con uno o dos días de retraso: hay datos hasta el{' '}
          {dayLabel(report.dataUntil)}.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {report.networks.map((n) => (
          <NetworkCard key={n.network} n={n} compare={report.previousComplete} />
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Alcance por día</CardTitle>
          <CardDescription>
            Personas distintas que vieron tus publicaciones o tu perfil cada día. Un día sin dato de
            Meta queda en blanco.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReachChart networks={report.networks} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">De las redes a tu web</CardTitle>
          <CardDescription>
            Quien entró en tu web desde Instagram o Facebook y lo que hizo después.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-medium">Red</th>
                <th className="px-2 py-2 text-right font-medium">Visitantes</th>
                <th className="px-2 py-2 text-right font-medium">Contactos</th>
                <th className="px-2 py-2 text-right font-medium">Reservas</th>
              </tr>
            </thead>
            <tbody>
              {report.web.map((w) => (
                <tr key={w.network} className="border-b last:border-0">
                  <td className="px-2 py-2 font-medium">{NETWORK[w.network].label}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{int(w.visitors)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{int(w.contacts)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{int(w.bookings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pi.posts > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Qué funciona en tus publicaciones</CardTitle>
            <CardDescription>
              {int(pi.posts)} {pi.posts === 1 ? 'publicación' : 'publicaciones'} en el periodo ·{' '}
              {int(pi.interactions)} interacciones
              {pi.engagementRate != null
                ? ` · ${(pi.engagementRate * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} % de interacción sobre el alcance`
                : ''}
              {pi.linkClicks > 0 ? ` · ${int(pi.linkClicks)} clics al enlace (Facebook)` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {(pi.bestWeekday || pi.bestHour) && (
              <p>
                Mejor momento para publicar:{' '}
                <strong>
                  {[
                    pi.bestWeekday ? WEEKDAY_NAMES[pi.bestWeekday.weekday] : null,
                    pi.bestHour ? `hacia las ${pi.bestHour.hour}:00` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </strong>{' '}
                <span className="text-muted-foreground">
                  (las publicaciones de entonces tienen más interacción de media).
                </span>
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Formato</th>
                    <th className="px-2 py-2 text-right font-medium">Publicaciones</th>
                    <th className="px-2 py-2 text-right font-medium">Interacción media</th>
                    <th className="px-2 py-2 text-right font-medium">Alcance medio</th>
                  </tr>
                </thead>
                <tbody>
                  {pi.formats.map((f) => (
                    <tr key={f.format} className="border-b last:border-0">
                      <td className="px-2 py-2">{FORMAT_LABELS[f.format] ?? f.format}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{int(f.posts)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {f.avgInteractions.toLocaleString('es-ES', { maximumFractionDigits: 1 })}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {f.avgReach != null ? int(f.avgReach) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tus mejores publicaciones</CardTitle>
          <CardDescription>
            Las de cada red por separado: en Instagram por alcance y en Facebook por interacción
            (Meta no da su alcance).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.topPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin publicaciones en este periodo.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {report.topPosts.map((p) => (
                <li
                  key={`${p.network}-${p.publishedAt}-${p.permalink}`}
                  className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
                >
                  {p.thumbnailUrl && (
                    // Miniaturas de Meta: dominios variables, sin optimizar.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="aspect-square w-full rounded-md object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {NETWORK[p.network].label} ·{' '}
                      {new Date(p.publishedAt).toLocaleDateString('es-ES', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    {p.permalink && (
                      <a
                        href={p.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Ver <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <p className="line-clamp-3">{p.caption || 'Sin texto'}</p>
                  <p className="mt-auto text-xs text-muted-foreground">
                    {[
                      p.reach != null ? `${int(p.reach)} de alcance` : null,
                      p.likes != null ? `${int(p.likes)} me gusta` : null,
                      p.comments != null ? `${int(p.comments)} comentarios` : null,
                      p.saves ? `${int(p.saves)} guardados` : null,
                      p.linkClicks ? `${int(p.linkClicks)} clics al enlace` : null,
                      p.engagementRate != null
                        ? `${(p.engagementRate * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} % de interacción`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Cifras de Instagram y Facebook con selector de periodo. */
export function SocialReportSection() {
  const [days, setDays] = useState<number>(30);
  const report = useSocialReport(days);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.data ? `Del ${dayLabel(report.data.from)} al ${dayLabel(report.data.to)}` : ''}
        </p>
        <div className="flex gap-1 rounded-md border p-1" role="group" aria-label="Periodo">
          {SOCIAL_REPORT_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                days === d
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {d} días
            </button>
          ))}
        </div>
      </div>
      {report.isError ? (
        <SectionError onRetry={() => void report.refetch()} />
      ) : report.isLoading || !report.data ? (
        <div role="status" aria-label="Cargando">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Report report={report.data} />
      )}
    </section>
  );
}
