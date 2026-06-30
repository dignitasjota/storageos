'use client';

import { CheckCircle2, Circle } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminTenantOnboarding } from '@/lib/admin/hooks';

export function OnboardingCard({ tenantId }: { tenantId: string }) {
  const { data } = useAdminTenantOnboarding(tenantId);
  if (!data) return null;

  const pct = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          Puesta a punto
          <span className="text-sm font-normal text-muted-foreground">
            {data.completed}/{data.total}
          </span>
        </CardTitle>
        <CardDescription>Qué le falta configurar a este tenant para operar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <ul className="space-y-1.5">
          {data.items.map((it) => (
            <li key={it.key} className="flex items-center gap-2 text-sm">
              {it.done ? (
                <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground/50" />
              )}
              <span className={it.done ? '' : 'text-muted-foreground'}>{it.label}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
