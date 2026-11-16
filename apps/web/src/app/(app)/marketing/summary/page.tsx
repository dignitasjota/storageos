'use client';

import {
  leadSourceLabel,
  trafficSourceName,
  monthLabel,
  previousMonth,
  type MarketingMonthFigures,
  type MarketingPreviousCoverage,
  type MarketingTipDto,
} from '@storageos/shared';
import { AlertTriangle, CheckCircle2, Info, Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useMarketingSummary,
  useSendMarketingReport,
  useSetMarketingReport,
} from '@/lib/marketing/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const int = (n: number) => n.toLocaleString('es-ES');
const sourceLabel = (s: string, paid = false) => trafficSourceName(s, paid, leadSourceLabel);

/** Variación frente al mes anterior; null sin datos de antes. */
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

const TIP_STYLE: Record<
  MarketingTipDto['kind'],
  { icon: typeof Info; className: string; label: string }
> = {
  warning: {
    icon: AlertTriangle,
    className: 'text-amber-600 dark:text-amber-400',
    label: 'Para revisar',
  },
  good: {
    icon: CheckCircle2,
    className: 'text-emerald-600 dark:text-emerald-400',
    label: 'Funciona',
  },
  info: { icon: Info, className: 'text-primary', label: 'Siguiente paso' },
};

/** Mes en curso del navegador (`YYYY-MM`). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type Kpi = {
  label: string;
  value: (f: MarketingMonthFigures) => number | null;
  /** Importe: solo con el permiso que corresponde. */
  money?: 'revenue' | 'cost';
  /** De qué fuente sale (sin datos de todo el mes anterior no se compara). */
  cover?: keyof MarketingPreviousCoverage;
  hint?: string;
};

const KPIS: Kpi[] = [
  { label: 'Visitantes de la web', value: (f) => f.visitors, cover: 'web' },
  {
    label: 'Clics en llamar y WhatsApp',
    value: (f) => f.contactClicks,
    cover: 'web',
    hint: 'Clics en llamar, WhatsApp, email y cómo llegar',
  },
  { label: 'Contactos nuevos', value: (f) => f.allContacts, hint: 'De cualquier origen' },
  { label: 'Reservas online', value: (f) => f.bookings },
  { label: 'Firmadas', value: (f) => f.signed },
  {
    label: 'Cobrado en el primer pago',
    value: (f) => f.revenue,
    money: 'revenue',
    hint: 'Sin IVA, sin fianza y descontando devoluciones',
  },
  { label: 'Gasto en marketing', value: (f) => f.spend, money: 'cost' },
  {
    label: 'Clics en tus anuncios',
    value: (f) => (f.adClicks > 0 ? f.adClicks : null),
    hint: 'Google Ads y Meta Ads',
  },
  { label: 'Sesiones (Google Analytics)', value: (f) => f.ga4Sessions, cover: 'ga4' },
  { label: 'Clics desde Google', value: (f) => f.searchClicks },
  {
    label: 'Alcance en redes',
    value: (f) => f.socialReach,
    cover: 'social',
    hint: 'Instagram y Facebook: la suma del alcance de cada día',
  },
  {
    label: 'Seguidores en redes',
    value: (f) => f.socialFollowers,
    hint: 'Instagram y Facebook, al final del mes',
  },
];

/** Texto de cada enlace de los consejos (no «Ir»). */
const TIP_LINK: Record<string, string> = {
  '/marketing/performance': 'Ver el rendimiento',
  '/marketing/web': 'Ver las visitas',
  '/marketing/social': 'Ver las redes',
  '/marketing/channels': 'Ver los canales',
  '/contracts': 'Ver los contratos',
  '/invoices?status=issued': 'Ver las facturas',
  '/settings/web': 'Revisar la web',
  '/seo': 'Ver posiciones en Google',
};

export default function MarketingSummaryPage() {
  const canManage = useHasPermission('marketing:manage');
  const [month, setMonth] = useState<string | null>(null);
  const summary = useMarketingSummary(month);
  const setReport = useSetMarketingReport();
  const sendReport = useSendMarketingReport();

  const months = useMemo(() => {
    const now = currentMonth();
    const list = [now];
    for (let i = 0; i < 12; i++) list.push(previousMonth(list[list.length - 1]!));
    return list;
  }, []);
  const selected = month ?? previousMonth(currentMonth());
  const data = summary.data;

  async function send() {
    try {
      const res = await sendReport.mutateAsync();
      toast.success(
        res.recipients > 0
          ? `Enviado a ${res.recipients} ${res.recipients === 1 ? 'propietario' : 'propietarios'}`
          : 'No hay propietarios con el email verificado',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Resumen de marketing</h1>
          <p className="text-sm text-muted-foreground">
            De dónde llegaron tus clientes cada mes y qué hacer, frente al mes anterior.
          </p>
        </div>
        <Select value={selected} onValueChange={(v) => setMonth(v)}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Mes">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m, i) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
                {i === 0 ? ' (en curso)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {summary.isError ? (
        <Card>
          <CardContent>
            <SectionError onRetry={() => void summary.refetch()} />
          </CardContent>
        </Card>
      ) : summary.isLoading || !data ? (
        <div className="flex justify-center py-16" role="status" aria-label="Cargando">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {data.partial && (
            <p className="text-sm text-muted-foreground">
              Mes en curso: se compara con los mismos días del mes anterior.
            </p>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Qué hacer</CardTitle>
              <CardDescription>Según lo que pasó en {data.label}.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.tips.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nada que revisar este mes. Sigue así.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.tips.map((tip) => {
                    const style = TIP_STYLE[tip.kind];
                    const Icon = style.icon;
                    return (
                      <li key={tip.text} className="flex gap-3 text-sm">
                        <Icon className={`mt-0.5 size-4 shrink-0 ${style.className}`} />
                        <div className="min-w-0 flex-1">
                          <span className="sr-only">{style.label}: </span>
                          {tip.text}
                          {tip.href && (
                            <>
                              {' '}
                              <Link href={tip.href} className="text-primary hover:underline">
                                {TIP_LINK[tip.href] ?? 'Ver'}
                              </Link>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {KPIS.map((k) => {
              if (k.money && !data.money[k.money]) return null;
              const now = k.value(data.current);
              if (now == null) return null;
              // Sin dato del mes anterior (o sin datos de todo él), «antes —».
              const covered = !k.cover || data.previousComplete[k.cover];
              const before = covered ? k.value(data.previous) : null;
              const d = before != null ? delta(now, before) : null;
              const fmt = (n: number) => (k.money ? eur(n) : int(n));
              return (
                <div key={k.label} className="rounded-lg border bg-card p-3" title={k.hint}>
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-xl font-semibold tabular-nums">{fmt(now)}</div>
                  <div className="text-xs text-muted-foreground">
                    {d && <span className={d.className}>{d.text} </span>}
                    antes {before != null ? fmt(before) : '—'}
                  </div>
                  {k.hint && <div className="sr-only">{k.hint}</div>}
                </div>
              );
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Por origen</CardTitle>
              <CardDescription>
                El origen sale de los enlaces de cada canal y de la web desde la que llegan.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.sources.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Sin visitas ni contactos con origen en {data.label}.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-2 py-2 font-medium">Origen</th>
                        <th className="px-2 py-2 text-right font-medium">Visitantes</th>
                        <th className="px-2 py-2 text-right font-medium">Contactos</th>
                        <th className="px-2 py-2 text-right font-medium">Reservas</th>
                        {data.money.revenue && (
                          <th className="px-2 py-2 text-right font-medium">Cobrado</th>
                        )}
                        {data.money.cost && (
                          <>
                            <th className="px-2 py-2 text-right font-medium">Gasto</th>
                            <th className="px-2 py-2 text-right font-medium">Coste/reserva</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.sources.map((s) => (
                        <tr key={`${s.source}-${s.paidTraffic}`} className="border-b last:border-0">
                          <td className="px-2 py-2 font-medium">
                            {sourceLabel(s.source, s.paidTraffic)}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{int(s.visitors)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{int(s.contacts)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{int(s.bookings)}</td>
                          {data.money.revenue && (
                            <td className="px-2 py-2 text-right tabular-nums">{eur(s.revenue)}</td>
                          )}
                          {data.money.cost && (
                            <>
                              <td className="px-2 py-2 text-right tabular-nums">
                                {s.cost > 0 ? eur(s.cost) : '—'}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums">
                                {s.costPerBooking != null ? eur(s.costPerBooking) : '—'}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Correo mensual</CardTitle>
              <CardDescription>
                A principios de cada mes (del día 4 al 10) los propietarios reciben «Tu marketing en
                …» con este resumen del mes anterior. Si el mes no tuvo actividad, no se envía.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label="Enviar el correo cada mes"
                  checked={data.reportEnabled}
                  disabled={!canManage || setReport.isPending}
                  onCheckedChange={(v) => setReport.mutate(v === true)}
                />
                Enviar el correo cada mes
              </label>
              {canManage && (
                <Button size="sm" variant="outline" onClick={send} disabled={sendReport.isPending}>
                  {sendReport.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 size-4" />
                  )}
                  Enviar el del mes pasado ahora
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
