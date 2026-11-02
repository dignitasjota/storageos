'use client';

import { PLATFORM_EMAIL_KIND_INFO, type PlatformEmailKind } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
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

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEmailProblems, useEmailStats } from '@/lib/admin/comms-hooks';
import { formatDateTime } from '@/lib/format';

// Colores de estado (entregado, en camino, fallido, rebotado) de las gráficas del panel.
const SERIES = [
  { key: 'delivered', label: 'Entregados', color: '#1baf7a' },
  { key: 'pending', label: 'En camino', color: '#94a3b8' },
  { key: 'failed', label: 'Fallidos o bloqueados', color: '#eda100' },
  { key: 'bounced', label: 'Rebotados', color: '#e34948' },
] as const;

function kindLabel(kind: string | null): string {
  if (!kind) return 'Otros';
  return PLATFORM_EMAIL_KIND_INFO[kind as PlatformEmailKind]?.label ?? kind;
}

/** Correos por semana y por tipo. */
export function EmailStatsPanel() {
  const stats = useEmailStats(8);
  if (stats.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const weeks = (stats.data?.weeks ?? []).map((w) => ({
    label: new Date(`${w.week}T00:00:00`).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
    }),
    delivered: w.delivered,
    bounced: w.bounced,
    failed: w.failed,
    pending: Math.max(0, w.sent - w.delivered - w.bounced - w.failed),
  }));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Correos por semana</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 600, height: 256 }}
            >
              <BarChart data={weeks} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.15} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip cursor={{ fillOpacity: 0.06 }} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value: string) => <span className="text-foreground">{value}</span>}
                />
                {SERIES.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stackId="a"
                    fill={s.color}
                    stroke="var(--background, #fff)"
                    strokeWidth={2}
                    radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por tipo de correo (8 semanas)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Tipo</th>
                <th className="py-1.5 pr-3 text-right font-medium">Total</th>
                <th className="py-1.5 pr-3 text-right font-medium">Entregados</th>
                <th className="py-1.5 pr-3 text-right font-medium">Rebotados</th>
                <th className="py-1.5 pr-3 text-right font-medium">Fallidos</th>
                <th className="py-1.5 text-right font-medium">Bloqueados</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(stats.data?.byKind ?? []).map((k) => (
                <tr key={k.kind ?? 'other'}>
                  <td className="py-1.5 pr-3">{kindLabel(k.kind)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{k.total}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{k.delivered}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{k.bounced}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{k.failed}</td>
                  <td className="py-1.5 text-right tabular-nums">{k.suppressed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Direcciones con rebotes o fallos repetidos en 90 días. */
export function EmailProblemsPanel() {
  const problems = useEmailProblems();
  if (problems.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const rows = problems.data ?? [];
  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        Ninguna dirección con rebotes o fallos repetidos en 90 días.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border bg-card">
      {rows.map((p) => (
        <li key={p.recipient} className="space-y-1 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.recipient}</span>
            {p.isOwner && <Badge variant="destructive">Propietario</Badge>}
            <span className="text-xs text-muted-foreground">
              {p.bounced} rebote(s) · {p.failed} fallo(s) · último el {formatDateTime(p.lastAt)}
            </span>
          </div>
          {p.tenantId && (
            <Link
              href={`/admin/tenants/${p.tenantId}`}
              className="text-xs text-primary hover:underline"
            >
              {p.tenantName ?? 'Ver tenant'}
            </Link>
          )}
          {p.lastError && <p className="text-xs text-destructive">{p.lastError}</p>}
        </li>
      ))}
    </ul>
  );
}
