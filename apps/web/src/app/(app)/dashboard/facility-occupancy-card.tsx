'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOccupancy } from '@/lib/analytics/hooks';

function pctOf(occupied: number, total: number): number {
  return total > 0 ? Math.round((occupied / total) * 100) : 0;
}

function barColor(pct: number): string {
  if (pct >= 85) return '#16a34a';
  if (pct >= 60) return '#2563eb';
  if (pct >= 35) return '#eab308';
  return '#ef4444';
}

export function FacilityOccupancyCard() {
  const q = useOccupancy();

  const facilities = (q.data?.perFacility ?? [])
    .map((f) => ({ ...f, pct: pctOf(f.occupied, f.total) }))
    .sort((a, b) => b.pct - a.pct);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ocupación por local</CardTitle>
        <CardDescription>Trasteros alquilados en cada local.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : facilities.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Aún no hay locales con trasteros.
          </p>
        ) : (
          <ul className="space-y-4">
            {facilities.map((f) => (
              <li key={f.facilityId} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{f.facilityName}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {f.pct}% · {f.occupied}/{f.total}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${f.pct}%`, backgroundColor: barColor(f.pct) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
