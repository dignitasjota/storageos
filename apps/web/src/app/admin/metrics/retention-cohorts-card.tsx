'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminRetention } from '@/lib/admin/hooks';

/** Color de la celda según el % de retención (verde alto → rojo bajo). */
function cellStyle(pct: number | null): { className: string; text: string } {
  if (pct === null) return { className: 'bg-transparent text-transparent', text: '' };
  const text = `${Math.round(pct)}%`;
  if (pct >= 90) return { className: 'bg-green-600 text-white', text };
  if (pct >= 75) return { className: 'bg-green-500 text-white', text };
  if (pct >= 60) return { className: 'bg-green-400 text-green-950', text };
  if (pct >= 45) return { className: 'bg-yellow-400 text-yellow-950', text };
  if (pct >= 30) return { className: 'bg-orange-400 text-orange-950', text };
  if (pct >= 15) return { className: 'bg-orange-500 text-white', text };
  return { className: 'bg-red-500 text-white', text };
}

export function RetentionCohortsCard() {
  const q = useAdminRetention();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Cohortes de retención</CardTitle>
        <p className="text-xs text-muted-foreground">
          De los tenants que se dieron de alta cada mes, qué % sigue activo N meses después (M0 = al
          alta).
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.cohorts.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Aún no hay cohortes de tenants.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Cohorte</th>
                  <th className="px-2 py-1 text-right font-medium">Altas</th>
                  {Array.from({ length: q.data.maxOffset + 1 }, (_, k) => (
                    <th key={k} className="px-2 py-1 text-center font-medium">
                      M{k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.cohorts.map((c) => (
                  <tr key={c.cohort}>
                    <td className="whitespace-nowrap px-2 py-1 font-medium">{c.cohort}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {c.size}
                    </td>
                    {Array.from({ length: q.data!.maxOffset + 1 }, (_, k) => {
                      const s = cellStyle(c.retention[k] ?? null);
                      return (
                        <td
                          key={k}
                          className={`rounded px-2 py-1 text-center tabular-nums ${s.className}`}
                        >
                          {s.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
