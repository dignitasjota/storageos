'use client';

import {
  WEB_ANALYTICS_DAYS,
  leadSourceLabel,
  type WebAnalyticsDto,
  type WebAnalyticsSourceDto,
} from '@storageos/shared';
import { Loader2, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Ga4Section } from './ga4-section';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useWebAnalytics } from '@/lib/marketing/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const int = (n: number) => n.toLocaleString('es-ES');

const SOURCE_LABELS: Record<string, string> = {
  web: 'Directo / sin origen',
  instagram: 'Instagram',
  facebook: 'Facebook',
  google: 'Google',
  bing: 'Bing',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X (Twitter)',
  whatsapp: 'WhatsApp',
};
const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? leadSourceLabel(s);

const DEVICE_LABELS = { mobile: 'Móvil', desktop: 'Ordenador', tablet: 'Tableta' } as const;

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** Variación frente al periodo anterior («+12 %»); null sin datos de antes. */
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

function Kpi({
  label,
  value,
  previous,
  hint,
}: {
  label: string;
  value: string;
  previous?: { now: number; before: number };
  hint?: string;
}) {
  const d = previous ? delta(previous.now, previous.before) : null;
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {d ? (
          <p className="text-xs text-muted-foreground">
            <span className={d.className}>{d.text}</span> frente al periodo anterior
          </p>
        ) : hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VisitsChart({ data }: { data: WebAnalyticsDto['daily'] }) {
  const points = data.map((d) => ({ ...d, label: dayLabel(d.date) }));
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 300, height: 224 }}
      >
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="visitsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            width={36}
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
            formatter={(value, name) => [
              int(Number(value)),
              name === 'visitors' ? 'Visitantes' : name === 'contacts' ? 'Contactos' : String(name),
            ]}
          />
          <Area
            type="monotone"
            dataKey="visitors"
            name="visitors"
            stroke="#2563eb"
            strokeWidth={2}
            fill="url(#visitsFill)"
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function SourcesTable({ rows }: { rows: WebAnalyticsSourceDto[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Aún no hay visitas en este periodo.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-2 py-2 font-medium">Origen</th>
            <th className="px-2 py-2 text-right font-medium">Visitantes</th>
            <th className="px-2 py-2 text-right font-medium">Llamadas</th>
            <th className="px-2 py-2 text-right font-medium">WhatsApp</th>
            <th className="px-2 py-2 text-right font-medium">Contactos</th>
            <th className="px-2 py-2 text-right font-medium">Reservas</th>
            <th className="px-2 py-2 text-right font-medium">Firmadas</th>
            <th className="px-2 py-2 text-right font-medium">Ingresos</th>
            <th className="px-2 py-2 text-right font-medium">Gasto</th>
            <th className="px-2 py-2 text-right font-medium">Coste/reserva</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className="border-b last:border-0">
              <td className="px-2 py-2 font-medium">{sourceLabel(r.source)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.visitors)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.calls)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.whatsapp)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.contacts)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.bookings)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{int(r.signed)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{eur(r.revenue)}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.cost > 0 ? eur(r.cost) : '—'}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.costPerBooking != null ? eur(r.costPerBooking) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function WebAnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const q = useWebAnalytics(days);
  const data = q.data;
  const t = data?.totals;
  const contactClicks = t ? t.calls + t.whatsapp + t.emails + t.directions : 0;
  const totalDeviceVisitors = data?.devices.reduce((n, d) => n + d.visitors, 0) ?? 0;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Visitas de la web</h1>
          <p className="text-sm text-muted-foreground">
            Quién visita tu web, de dónde viene y cuántos acaban contactando, reservando y pagando.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border p-1">
          {WEB_ANALYTICS_DAYS.map((d) => (
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

      {q.isLoading || !data || !t ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi
              label="Visitantes"
              value={int(t.visitors)}
              previous={{ now: t.visitors, before: data.previous.visitors }}
            />
            <Kpi
              label="Llamadas y WhatsApp"
              value={int(t.calls + t.whatsapp)}
              hint={`${int(contactClicks)} ${contactClicks === 1 ? 'clic' : 'clics'} de contacto en total`}
            />
            <Kpi
              label="Contactos"
              value={int(t.contacts)}
              previous={{ now: t.contacts, before: data.previous.contacts }}
            />
            <Kpi
              label="Reservas"
              value={int(t.bookings)}
              previous={{ now: t.bookings, before: data.previous.bookings }}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Visitantes por día</CardTitle>
              <CardDescription>
                {int(t.pageViews)} {t.pageViews === 1 ? 'página vista' : 'páginas vistas'} ·{' '}
                {int(t.visitors)} {t.visitors === 1 ? 'visitante' : 'visitantes'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <VisitsChart data={data.daily} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">De dónde vienen</CardTitle>
              <CardDescription>
                Del primer clic a la reserva pagada. El gasto sale de los canales de marketing con
                ese origen.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SourcesTable rows={data.sources} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Páginas más vistas</CardTitle>
              </CardHeader>
              <CardContent>
                {data.pages.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Sin visitas.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-2 py-2 font-medium">Página</th>
                        <th className="px-2 py-2 text-right font-medium">Vistas</th>
                        <th className="px-2 py-2 text-right font-medium">Visitantes</th>
                        <th className="px-2 py-2 text-right font-medium">Clics de contacto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pages.map((p) => (
                        <tr key={p.path} className="border-b last:border-0">
                          <td className="max-w-[16rem] truncate px-2 py-2 font-mono text-xs">
                            {p.path}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{int(p.pageViews)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{int(p.visitors)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {int(p.contactClicks)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Clics de contacto</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {[
                    { icon: Phone, label: 'Llamar', value: t.calls },
                    { icon: MessageCircle, label: 'WhatsApp', value: t.whatsapp },
                    { icon: Mail, label: 'Email', value: t.emails },
                    { icon: MapPin, label: 'Cómo llegar', value: t.directions },
                  ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Icon className="size-4" /> {label}
                      </span>
                      <span className="font-medium tabular-nums">{int(value)}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Dispositivo</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {data.devices.length === 0 ? (
                    <p className="text-muted-foreground">Sin visitas.</p>
                  ) : (
                    data.devices.map((d) => {
                      const pct = totalDeviceVisitors
                        ? Math.round((d.visitors / totalDeviceVisitors) * 100)
                        : 0;
                      return (
                        <div key={d.device} className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{DEVICE_LABELS[d.device]}</span>
                            <span className="font-medium tabular-nums">{pct} %</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted">
                            <div
                              className="h-1.5 rounded-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Ga4Section days={days} ownVisitors={t.visitors} />

          <p className="text-xs text-muted-foreground">
            Lo mide TrasterOS en tu web, sin cookies de terceros: cuenta todas las visitas aunque el
            visitante no acepte las cookies (por eso puede no coincidir con Google Analytics). Las
            visitas de robots no cuentan. El origen se recuerda 30 días: si alguien llega desde
            Instagram y reserva una semana después, la reserva cuenta para Instagram.
          </p>
        </>
      )}
    </div>
  );
}
