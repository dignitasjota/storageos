'use client';

import { Loader2 } from 'lucide-react';

import type { AdminTenantHealthLevel } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card';
import { useAdminTenantHealth } from '@/lib/admin/hooks';

const LEVEL: Record<AdminTenantHealthLevel, { label: string; badge: string; bar: string }> = {
  healthy: {
    label: 'Saludable',
    badge: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    bar: 'bg-green-500',
  },
  warm: { label: 'Tibio', badge: 'bg-sky-100 text-sky-700', bar: 'bg-sky-500' },
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Salud</CardTitle>
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
                <ul className="space-y-2 pt-1">
                  {d.factors.map((f) => (
                    <li key={f.key} className="text-sm">
                      <div className="flex items-center justify-between">
                        <span>{f.label}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {f.score}/100
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-foreground/40" style={{ width: `${f.score}%` }} />
                      </div>
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
