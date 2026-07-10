'use client';

import { AlertTriangle, Loader2, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminSecurityStats } from '@/lib/admin/hooks';

type Window = '24h' | '7d' | '30d';

function formatBucket(bucketIso: string, bucketSize: 'hour' | 'day'): string {
  const d = new Date(bucketIso);
  if (bucketSize === 'hour') {
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
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
            <KpiCard label="IPs únicas" value={data.topIps.length} />
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
                  Alertas activas (≥ {data.bruteForceThreshold} fallos en ventana)
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
                  <ResponsiveContainer width="100%" height="100%">
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
                            <td className="text-right">
                              <Badge variant={t.exceedsThreshold ? 'destructive' : 'secondary'}>
                                {t.count}
                              </Badge>
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
                            <td className="py-1.5 font-mono text-xs">{t.email}</td>
                            <td className="text-right">
                              <Badge variant={t.exceedsThreshold ? 'destructive' : 'secondary'}>
                                {t.count}
                              </Badge>
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
