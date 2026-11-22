'use client';

import {
  CHURN_RISK_LABELS,
  PAY_PROBABILITY_LABELS,
  type AdminTenantHealthLevel,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';

import { Sparkline } from '@/components/admin/health/sparkline';
import { TenantRowActions } from '@/components/admin/health/tenant-row-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card';
import { useTenantHealthHistory } from '@/lib/admin/health-insights-hooks';
import { useAdminTenantHealth } from '@/lib/admin/hooks';
import { formatEur, plural } from '@/lib/format';

const LEVEL: Record<AdminTenantHealthLevel, { label: string; badge: string; bar: string }> = {
  healthy: {
    label: 'Saludable',
    badge: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    bar: 'bg-green-500',
  },
  warm: {
    label: 'Tibio',
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    bar: 'bg-sky-500',
  },
  at_risk: {
    label: 'En riesgo',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    bar: 'bg-amber-500',
  },
  dormant: {
    label: 'Dormido',
    badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    bar: 'bg-red-500',
  },
};

export function TenantHealthCard({ tenantId }: { tenantId: string }) {
  const health = useAdminTenantHealth(tenantId);
  const history = useTenantHealthHistory(tenantId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {health.data?.kind === 'activation' ? 'Activación de la prueba' : 'Salud'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {health.isLoading || !health.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          (() => {
            const d = health.data;
            const lvl = LEVEL[d.level];
            return (
              <div className="space-y-3">
                <div className="flex items-end justify-between">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold tabular-nums">{d.score}</span>
                    <span className="text-sm text-muted-foreground">/100</span>
                  </div>
                  <Badge className={`${lvl.badge} border-0`}>{lvl.label}</Badge>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className={`h-full ${lvl.bar}`} style={{ width: `${d.score}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {d.churnRisk && (
                    <span className="font-medium text-foreground">
                      {CHURN_RISK_LABELS[d.churnRisk]}
                    </span>
                  )}
                  {d.payProbabilityLevel && (
                    <span className="font-medium text-foreground">
                      {PAY_PROBABILITY_LABELS[d.payProbabilityLevel]} que pague ({d.payProbability}{' '}
                      %)
                    </span>
                  )}
                  {d.mrr > 0 && <span>{formatEur(d.mrr)}/mes sin IVA</span>}
                  {d.trend !== null && d.trend !== 0 && (
                    <span>
                      {d.trend > 0 ? '▲' : '▼'} {Math.abs(d.trend)} frente al mes pasado
                    </span>
                  )}
                  <span>
                    {d.activeDays30 !== null
                      ? `${plural(d.activeDays30, 'día activo', 'días activos')} de 30 · ${d.activeUsers30 ?? 0} de ${plural(d.totalUsers, 'usuario', 'usuarios')}`
                      : 'Aún sin registro de días activos'}
                  </span>
                </div>
                {d.mainDrag && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
                    <p>
                      <span className="font-medium">Lo que más resta:</span>{' '}
                      {d.mainDrag.label.toLowerCase()} (−{d.mainDrag.lostPoints} puntos) ·{' '}
                      {d.mainDrag.detail}
                    </p>
                    <TenantRowActions
                      tenantId={tenantId}
                      tenantName={d.name}
                      suggested={d.mainDrag.action}
                    />
                  </div>
                )}
                <HealthHistory history={history.data} />
                <ul className="space-y-2 pt-1">
                  {d.factors.map((f) => (
                    <li key={f.key} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0">
                          {f.label}
                          {f.counted && (
                            <span className="text-xs text-muted-foreground">
                              {' '}
                              · {Math.round(f.weight * 100)} %
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          {f.counted ? `${f.score}/100` : 'no cuenta'}
                        </span>
                      </div>
                      {f.counted && (
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-foreground/40"
                            style={{ width: `${f.score}%` }}
                          />
                        </div>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">{f.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()
        )}
      </CardContent>
    </Card>
  );
}

/** Evolución: una foto por mes (12) y la de cada día de los últimos 90. */
function HealthHistory({
  history,
}: {
  history: ReturnType<typeof useTenantHealthHistory>['data'];
}) {
  if (!history || (history.monthly.length < 2 && history.daily.length < 2)) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {history.monthly.length >= 2 && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-28 shrink-0">Últimos meses</span>
          <Sparkline
            values={history.monthly.map((m) => m.score)}
            width={160}
            height={28}
            label={history.monthly.map((m) => `${m.label}: ${m.score}`).join(' · ')}
          />
        </div>
      )}
      {history.daily.length >= 2 && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-28 shrink-0">Últimos 90 días</span>
          <Sparkline
            values={history.daily.map((m) => m.score)}
            width={160}
            height={28}
            label={`De ${history.daily[0]!.score} el ${history.daily[0]!.label} a ${history.daily[history.daily.length - 1]!.score}`}
          />
        </div>
      )}
      {history.biggestDrop && (
        <p>
          Mayor caída en una semana: {history.biggestDrop.points} puntos (hasta el{' '}
          {new Date(history.biggestDrop.date).toLocaleDateString('es-ES', { timeZone: 'UTC' })}).
        </p>
      )}
    </div>
  );
}
