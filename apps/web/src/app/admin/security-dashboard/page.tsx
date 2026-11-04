'use client';

import { AlertTriangle, Ban, Loader2, TrendingUp, X } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAdminSecurityStats,
  useCreateSecurityBlock,
  useRemoveSecurityBlock,
  useSecurityBlocks,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

type Window = '24h' | '7d' | '30d';

function formatBucket(bucketIso: string, bucketSize: 'hour' | 'day'): string {
  const d = new Date(bucketIso);
  if (bucketSize === 'hour') {
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

/** Botón para bloquear 24 h una IP o un email desde las tablas. */
function BlockButton({ kind, value }: { kind: 'ip' | 'email'; value: string }) {
  const create = useCreateSecurityBlock();
  const isSuperadmin = useIsSuperadmin();
  if (!isSuperadmin) return null;
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-7"
      aria-label={`Bloquear ${value}`}
      title="Bloquear 24 horas"
      disabled={create.isPending}
      onClick={() =>
        create.mutate(
          { kind, value, expiresInHours: 24 },
          {
            onSuccess: () => toast.success(`${value} bloqueado 24 horas.`),
            onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
          },
        )
      }
    >
      <Ban className="size-4" />
    </Button>
  );
}

/** Bloqueos activos y alta manual. */
function BlocksCard() {
  const blocks = useSecurityBlocks();
  const create = useCreateSecurityBlock();
  const remove = useRemoveSecurityBlock();
  const isSuperadmin = useIsSuperadmin();
  const [value, setValue] = useState('');
  const [hours, setHours] = useState('24');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    create.mutate(
      {
        kind: trimmed.includes('@') ? 'email' : 'ip',
        value: trimmed,
        ...(Number(hours) > 0 ? { expiresInHours: Number(hours) } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Bloqueo guardado.');
          setValue('');
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.body.message : 'Revisa el valor.'),
      },
    );
  }

  const rows = blocks.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bloqueos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isSuperadmin && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={onSubmit}>
            <Input
              className="w-64"
              aria-label="IP o email"
              placeholder="IP o email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Input
              className="w-24"
              type="number"
              min={0}
              aria-label="Horas (0 = sin fin)"
              title="Horas (0 = sin fin)"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={create.isPending || !value.trim()}>
              Bloquear
            </Button>
          </form>
        )}
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No hay nada bloqueado.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {rows.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 rounded border p-2">
                <span className="min-w-0 truncate">
                  <code className="font-mono">{b.value}</code>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {b.expiresAt
                      ? `hasta ${new Date(b.expiresAt).toLocaleString('es-ES')}`
                      : 'sin fin'}
                  </span>
                </span>
                {isSuperadmin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Quitar ${b.value}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(b.id)}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function SecurityDashboardPage() {
  const [windowSel, setWindowSel] = useState<Window>('24h');
  const { data, isLoading, error } = useAdminSecurityStats(windowSel);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard de seguridad</h1>
          <p className="text-muted-foreground text-sm">
            Eventos auth + alertas brute-force en tiempo casi real (refresca cada 60s).
          </p>
        </div>
        <Select value={windowSel} onValueChange={(v) => setWindowSel(v as Window)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Últimas 24 horas</SelectItem>
            <SelectItem value="7d">Últimos 7 días</SelectItem>
            <SelectItem value="30d">Últimos 30 días</SelectItem>
          </SelectContent>
        </Select>
      </header>

      {isLoading && (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Cargando…
        </div>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-destructive">Error cargando stats</CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label="Eventos totales" value={data.total} />
            <KpiCard label="Tipos distintos" value={data.byEventType.length} />
            <KpiCard label="IPs únicas" value={data.uniqueIps} />
            <KpiCard
              label="Alertas activas"
              value={data.activeAlerts.length}
              danger={data.activeAlerts.length > 0}
            />
          </div>

          {/* Active alerts */}
          {data.activeAlerts.length > 0 && (
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="size-4" />
                  Alertas activas (≥ {data.bruteForceThreshold} fallos en{' '}
                  {data.bruteForceWindowMinutes} min)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {data.activeAlerts.map((a) => (
                    <li
                      key={`${a.kind}:${a.identifier}`}
                      className="flex items-center justify-between rounded border border-destructive/30 p-2"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{a.kind}</Badge>
                        <code className="font-mono text-sm">{a.identifier}</code>
                      </span>
                      <Badge variant="destructive">{a.count} fallos</Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Timeseries */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="size-4" />
                Eventos por {data.bucket === 'hour' ? 'hora' : 'día'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.timeseries.length === 0 ? (
                <p className="text-muted-foreground py-12 text-center text-sm">
                  Sin eventos en la ventana
                </p>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 256 }}
                  >
                    <BarChart
                      data={data.timeseries.map((t) => ({
                        ...t,
                        label: formatBucket(t.bucket, data.bucket),
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" fontSize={11} />
                      <YAxis allowDecimals={false} fontSize={11} />
                      <Tooltip />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Entradas al panel admin */}
          {data.adminLogins.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Entradas al panel admin</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-56 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 224 }}
                  >
                    <BarChart
                      data={data.adminLogins.map((t) => ({
                        ...t,
                        label: formatBucket(t.bucket, data.bucket),
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" fontSize={11} />
                      <YAxis allowDecimals={false} fontSize={11} />
                      <Tooltip />
                      <Legend />
                      <Bar
                        dataKey="success"
                        name="Correctas"
                        fill="hsl(var(--primary))"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="failed"
                        name="Fallidas"
                        fill="hsl(var(--destructive))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          <BlocksCard />

          {/* Top tables */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top IPs</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topIps.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin datos</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="py-2">IP</th>
                          <th className="text-right">Fallos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topIps.map((t) => (
                          <tr key={t.ip} className="border-t">
                            <td className="py-1.5 font-mono">{t.ip}</td>
                            <td className="whitespace-nowrap text-right">
                              <Badge variant={t.exceedsThreshold ? 'destructive' : 'secondary'}>
                                {t.count}
                              </Badge>
                              <BlockButton kind="ip" value={t.ip} />
                            </td>
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
                <CardTitle>Top emails</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topEmails.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin datos</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="py-2">Email</th>
                          <th className="text-right">Fallos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topEmails.map((t) => (
                          <tr key={t.email} className="border-t">
                            <td className="py-1.5 text-xs">
                              <span className="font-mono">{t.email}</span>
                              {t.tenantId && (
                                <Link
                                  href={`/admin/tenants/${t.tenantId}`}
                                  className="text-primary ml-2 hover:underline"
                                >
                                  {t.tenantName}
                                </Link>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-right">
                              <Badge variant={t.exceedsThreshold ? 'destructive' : 'secondary'}>
                                {t.count}
                              </Badge>
                              <BlockButton kind="email" value={t.email} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* By event type breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>Por tipo de evento</CardTitle>
            </CardHeader>
            <CardContent>
              {data.byEventType.length === 0 ? (
                <p className="text-muted-foreground text-sm">Sin datos</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.byEventType.map((b) => (
                    <Badge key={b.eventType} variant="outline">
                      {b.eventType}
                      <span className="text-muted-foreground ml-2">{b.count}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <Card className={danger ? 'border-destructive' : ''}>
      <CardContent className="pt-6">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
        <p className={`mt-2 text-3xl font-bold ${danger ? 'text-destructive' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
