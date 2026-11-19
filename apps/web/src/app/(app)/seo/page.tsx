'use client';

import {
  ArrowDown,
  ArrowUp,
  Copy,
  Lightbulb,
  Loader2,
  Mail,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  BrandDevicesCards,
  GoogleFunnelCard,
  LowCtrCard,
  QueriesCard,
  ReportRecipients,
  SeoDetailDialog,
  TrackedKeywordsCard,
  WeeklyCard,
  YearAgoLine,
  type SeoTarget,
} from './seo-panels';

import type { SeoTotalsDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/auth/api';
import {
  useConnectSearchConsole,
  useDisconnectSearchConsole,
  useSearchConsole,
  useSendSeoReport,
  useSeoPositions,
  useSeoReport,
  useSyncSearchConsole,
  useToggleSeoReport,
} from '@/lib/seo/hooks';

const nf = new Intl.NumberFormat('es-ES');
const fmtPos = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const fmtPct = (n: number | null) =>
  n == null ? '—' : `${(n * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

/** Cambio de posición: positivo = sube (mejor). */
function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">nueva</span>;
  if (Math.abs(value) < 0.5) return <span className="text-xs text-muted-foreground">=</span>;
  const up = value > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        up ? 'text-emerald-600' : 'text-red-600 dark:text-red-400'
      }`}
    >
      <Icon className="size-3" />
      {fmtPos(Math.abs(value))}
    </span>
  );
}

function Kpi({
  label,
  value,
  previous,
  change,
  better,
}: {
  label: string;
  value: string;
  /** null = no hay periodo anterior completo con el que comparar. */
  previous: string | null;
  change: string | null;
  better: boolean | null;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p
          className={`text-xs ${
            better == null
              ? 'text-muted-foreground'
              : better
                ? 'text-emerald-600'
                : 'text-red-600 dark:text-red-400'
          }`}
        >
          {previous === null
            ? 'Antes: sin datos completos'
            : `Antes: ${previous}${change ? ` (${change})` : ''}`}
        </p>
      </CardContent>
    </Card>
  );
}

/** Variación en % (o en posiciones para la posición media). */
function changeOf(a: number | null, b: number | null, kind: 'pct' | 'positions' | 'points') {
  if (a == null || b == null || a === b) return null;
  if (kind === 'positions') {
    const d = Math.round((b - a) * 10) / 10;
    return d === 0 ? null : `${d > 0 ? 'sube' : 'baja'} ${fmtPos(Math.abs(d))}`;
  }
  if (kind === 'points') {
    const d = Math.round((a - b) * 1000) / 10;
    return d === 0 ? null : `${d > 0 ? '+' : ''}${d.toLocaleString('es-ES')} puntos`;
  }
  if (b === 0) return null;
  const p = Math.round(((a - b) / b) * 100);
  return p === 0 ? null : `${p > 0 ? '+' : ''}${p} %`;
}

function Kpis({
  now,
  before,
  comparable,
}: {
  now: SeoTotalsDto;
  before: SeoTotalsDto;
  comparable: boolean;
}) {
  const cmp = (a: number | null, b: number | null, lowerIsBetter = false) =>
    !comparable || a == null || b == null || a === b ? null : lowerIsBetter ? a < b : a > b;
  const prev = (v: string) => (comparable ? v : null);
  const change = (a: number | null, b: number | null, kind: 'pct' | 'positions' | 'points') =>
    comparable ? changeOf(a, b, kind) : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Clics desde Google"
        value={nf.format(now.clicks)}
        previous={prev(nf.format(before.clicks))}
        change={change(now.clicks, before.clicks, 'pct')}
        better={cmp(now.clicks, before.clicks)}
      />
      <Kpi
        label="Veces que apareces"
        value={nf.format(now.impressions)}
        previous={prev(nf.format(before.impressions))}
        change={change(now.impressions, before.impressions, 'pct')}
        better={cmp(now.impressions, before.impressions)}
      />
      <Kpi
        label="Posición media"
        value={fmtPos(now.position)}
        previous={prev(fmtPos(before.position))}
        change={change(now.position, before.position, 'positions')}
        better={cmp(now.position, before.position, true)}
      />
      <Kpi
        label="Porcentaje de clics"
        value={fmtPct(now.ctr)}
        previous={prev(fmtPct(before.ctr))}
        change={change(now.ctr, before.ctr, 'points')}
        better={cmp(now.ctr, before.ctr)}
      />
    </div>
  );
}

function ConnectCard() {
  const settings = useSearchConsole();
  const connect = useConnectSearchConsole();
  const disconnect = useDisconnectSearchConsole();
  const sync = useSyncSearchConsole();
  const ask = useConfirm();
  const [siteUrl, setSiteUrl] = useState('');
  const s = settings.data;

  if (settings.isError && !s) return <SectionError onRetry={() => void settings.refetch()} />;
  if (!s) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!s.available) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          La conexión con Search Console todavía no está disponible. Escríbenos desde Soporte y te
          avisamos en cuanto lo esté.
        </CardContent>
      </Card>
    );
  }

  const connected = s.status === 'connected';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Search Console</CardTitle>
        <CardDescription>
          Los datos salen de Google Search Console: las búsquedas por las que apareces, en qué
          posición y cuántos clics te dan. Google los publica con 2-3 días de retraso.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {s.siteUrl && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{s.siteUrl}</span>
            {connected ? <Badge>Conectada</Badge> : <Badge variant="destructive">Sin acceso</Badge>}
            {s.lastSyncedAt && (
              <span className="text-xs text-muted-foreground">
                Actualizada el {new Date(s.lastSyncedAt).toLocaleString('es-ES')}
              </span>
            )}
          </div>
        )}
        {s.lastError && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {connected ? `${s.lastError} Mientras tanto ves los datos que ya había.` : s.lastError}
          </p>
        )}

        {!connected && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Entra en{' '}
              <a
                href="https://search.google.com/search-console"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                Google Search Console
              </a>{' '}
              y añade tu web si aún no lo está (mejor como «Dominio»).
            </li>
            <li>
              En Configuración → Usuarios y permisos → Añadir usuario, pon este email con permiso
              «Restringido»:
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 text-xs">{s.serviceAccountEmail}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Copiar email"
                  onClick={() => {
                    void navigator.clipboard.writeText(s.serviceAccountEmail ?? '');
                    toast.success('Email copiado');
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </li>
            <li>
              Escribe aquí tu propiedad tal como sale en Search Console y pulsa «Conectar». Tiene
              que ser tu web en TrasterOS: tu dominio propio (<code>sc-domain:tudominio.es</code>) o
              tu dirección en la plataforma (la que acaba en <code>/s/tu-identificador/</code>).
            </li>
          </ol>
        )}

        <Can permission="settings:manage">
          {!connected && s.siteUrl && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (
                    await ask({
                      title: '¿Desconectar Search Console?',
                      description: 'Se borran los datos descargados. Puedes volver a conectarlo.',
                      confirmLabel: 'Desconectar',
                      destructive: true,
                    })
                  ) {
                    await disconnect.mutateAsync(undefined);
                  }
                }}
              >
                Desconectar
              </Button>
            </div>
          )}
          {!connected ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="gsc-site">Propiedad</Label>
                <Input
                  id="gsc-site"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder={s.siteUrl ?? 'sc-domain:tudominio.es'}
                />
              </div>
              <Button
                disabled={connect.isPending || !(siteUrl.trim() || s.siteUrl)}
                onClick={async () => {
                  try {
                    await connect.mutateAsync(siteUrl.trim() || s.siteUrl || '');
                    toast.success('Search Console conectado');
                    setSiteUrl('');
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo conectar');
                  }
                }}
              >
                {connect.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                Conectar
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={sync.isPending}
                onClick={async () => {
                  try {
                    await sync.mutateAsync(undefined);
                    toast.success('Datos actualizados');
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.body.message : 'No se pudieron actualizar.',
                    );
                  }
                }}
              >
                {sync.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 size-4" />
                )}
                Actualizar ahora
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (
                    await ask({
                      title: '¿Desconectar Search Console?',
                      description: 'Se borran los datos descargados. Puedes volver a conectarlo.',
                      confirmLabel: 'Desconectar',
                      destructive: true,
                    })
                  ) {
                    await disconnect.mutateAsync(undefined);
                  }
                }}
              >
                Desconectar
              </Button>
            </div>
          )}
        </Can>
      </CardContent>
    </Card>
  );
}

function MonthlyReportCard() {
  const settings = useSearchConsole();
  const report = useSeoReport(settings.data?.status === 'connected');
  const toggle = useToggleSeoReport();
  const send = useSendSeoReport();
  const r = report.data;
  if (!r) return null;
  const hasData = r.summary.totals.impressions > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-amber-500" /> Informe de {r.label}
        </CardTitle>
        <CardDescription>
          {hasData
            ? `${nf.format(r.summary.totals.clicks)} clics y ${nf.format(r.summary.totals.impressions)} apariciones en Google (el mes anterior: ${nf.format(r.summary.previousTotals.clicks)} y ${nf.format(r.summary.previousTotals.impressions)}).`
            : 'Todavía no hay datos de ese mes.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {r.tips.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            {r.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        ) : (
          hasData && (
            <p className="text-sm text-muted-foreground">Nada urgente que mejorar este mes.</p>
          )
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <Can permission="settings:manage">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={settings.data?.monthlyReport ?? true}
                disabled={toggle.isPending}
                onCheckedChange={(v) =>
                  toggle.mutate(v === true, {
                    onError: () => toast.error('No se pudo guardar. Inténtalo de nuevo.'),
                  })
                }
              />
              Enviar este informe cada mes (día 3)
            </label>
          </Can>
          <Button
            variant="outline"
            size="sm"
            disabled={send.isPending}
            onClick={async () => {
              try {
                const res = await send.mutateAsync();
                toast.success(
                  res.recipients > 0
                    ? 'Te lo hemos enviado a tu correo'
                    : 'Tu email no está verificado: verifícalo para recibirlo',
                );
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
              }
            }}
          >
            {send.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Mail className="mr-1 size-4" />
            )}
            Enviármelo ahora
          </Button>
          <ReportRecipients />
        </div>
      </CardContent>
    </Card>
  );
}

export default function SeoPage() {
  const settings = useSearchConsole();
  const connected = settings.data?.status === 'connected';
  // Con la propiedad guardada se ven los datos ya descargados, aunque la última
  // descarga haya fallado.
  const hasSite = Boolean(settings.data?.siteUrl);
  const [days, setDays] = useState(28);
  const [target, setTarget] = useState<SeoTarget | null>(null);
  const positions = useSeoPositions(days, hasSite);
  const d = positions.data;
  const areaPages = d?.pages.filter((p) => p.areaSlug) ?? [];
  const otherPages = d?.pages.filter((p) => !p.areaSlug) ?? [];

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Posiciones en Google</h1>
          <p className="text-sm text-muted-foreground">
            Cómo te encuentra la gente en Google: búsquedas, posición y clics de cada página.
          </p>
        </div>
        {hasSite && (
          <div className="flex gap-1">
            {[7, 28, 90].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={days === n ? 'default' : 'outline'}
                onClick={() => setDays(n)}
              >
                {n} días
              </Button>
            ))}
          </div>
        )}
      </div>

      <ConnectCard />

      {hasSite && positions.isLoading && (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {hasSite && positions.isError && !d && (
        <SectionError onRetry={() => void positions.refetch()} />
      )}

      {hasSite && d && (
        <>
          {d.lastDate ? (
            <p className="text-xs text-muted-foreground">
              Del {fmtDate(d.from)} al {fmtDate(d.to)}
              {d.previousComplete
                ? `, comparado con los ${days} días anteriores.`
                : `. Aún no hay ${days} días anteriores descargados para comparar (desde el ${fmtDate(d.firstDate ?? d.from)}).`}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Todavía no hay datos de Google para tu web. Suelen aparecer en unos días.
            </p>
          )}

          <Kpis now={d.totals} before={d.previousTotals} comparable={d.previousComplete} />
          <YearAgoLine d={d} />
          <WeeklyCard d={d} />

          {connected && <MonthlyReportCard />}

          {d.alerts.length > 0 && (
            <Card className="border-amber-300 dark:border-amber-800">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <TriangleAlert className="size-4 text-amber-600" /> Para revisar
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {d.alerts.map((a) => (
                    <li key={`${a.kind}-${a.label}`}>
                      <span className="font-medium">{a.label}</span>: {a.detail}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {d.opportunities.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Oportunidades</CardTitle>
                <CardDescription>
                  Búsquedas en las que ya sales entre la 4.ª y la 20.ª posición: mejorando el texto
                  de la página que las trabaja es donde antes subes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {d.opportunities.map((q) => (
                    <li key={q.query} className="flex items-center justify-between gap-3 py-2">
                      <button
                        type="button"
                        className="truncate text-left hover:underline"
                        onClick={() => setTarget({ kind: 'query', key: q.query, label: q.query })}
                      >
                        {q.query}
                      </button>
                      <span className="shrink-0 text-muted-foreground">
                        posición {fmtPos(q.position)} · {nf.format(q.impressions)} apariciones
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <LowCtrCard d={d} onOpen={setTarget} />
          <TrackedKeywordsCard days={days} onOpen={setTarget} />
          <BrandDevicesCards d={d} />
          <GoogleFunnelCard days={days} />
          <QueriesCard d={d} onOpen={setTarget} />

          {[
            { title: 'Páginas de zona', rows: areaPages },
            { title: 'Resto de páginas', rows: otherPages },
          ]
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <Card key={g.title}>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">{g.title}</CardTitle>
                  {g.title === 'Páginas de zona' && (
                    <Link
                      href="/settings/area-pages"
                      className="text-sm text-primary hover:underline"
                    >
                      Editar las páginas de zona
                    </Link>
                  )}
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Página</TableHead>
                        <TableHead className="hidden sm:table-cell">Búsqueda principal</TableHead>
                        <TableHead className="text-right">Clics</TableHead>
                        <TableHead className="text-right">Posición</TableHead>
                        <TableHead className="text-right">Cambio</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.rows.map((p) => (
                        <TableRow key={p.page}>
                          <TableCell className="max-w-[220px]">
                            <button
                              type="button"
                              className="max-w-full truncate text-left hover:underline"
                              onClick={() =>
                                setTarget({ kind: 'page', key: p.page, label: p.path })
                              }
                            >
                              {p.path}
                            </button>
                          </TableCell>
                          <TableCell className="hidden max-w-[200px] truncate text-muted-foreground sm:table-cell">
                            {p.topQuery ?? '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {nf.format(p.clicks)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtPos(p.position)}
                          </TableCell>
                          <TableCell className="text-right">
                            {d.previousComplete ? (
                              <Change
                                value={
                                  p.previousPosition == null
                                    ? null
                                    : p.previousPosition - p.position
                                }
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
        </>
      )}
      <SeoDetailDialog
        target={target}
        days={days}
        onClose={() => setTarget(null)}
        onOpen={setTarget}
      />
    </div>
  );
}
