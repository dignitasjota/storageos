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

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSocialReport } from '@/lib/marketing/hooks';

const int = (n: number) => n.toLocaleString('es-ES');

const NETWORK: Record<SocialNetwork, { label: string; color: string }> = {
  instagram: { label: 'Instagram', color: '#2563eb' },
  facebook: { label: 'Facebook', color: '#d97706' },
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
function NetworkCard({ n }: { n: SocialNetworkReportDto }) {
  const metrics: { key: keyof SocialTotals; label: string }[] = [
    { key: 'reach', label: 'Alcance' },
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
              const d = delta(n.totals[m.key], n.previous[m.key]);
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
              connectNulls
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
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {report.networks.map((n) => (
          <NetworkCard key={n.network} n={n} />
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Alcance por día</CardTitle>
          <CardDescription>
            Personas distintas que vieron tus publicaciones o tu perfil.
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
        <CardContent>
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tus mejores publicaciones</CardTitle>
          <CardDescription>Por alcance (o interacción, si Meta no da el alcance).</CardDescription>
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
        <div className="flex gap-1 rounded-md border p-1">
          {SOCIAL_REPORT_DAYS.map((d) => (
            <button
              key={d}
              type="button"
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
      {report.isLoading || !report.data ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (
        <Report report={report.data} />
      )}
    </section>
  );
}
