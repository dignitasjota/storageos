'use client';

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import type { ChurnRiskKpiDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur as eur } from '@/lib/format';

export function ChurnRiskCard({
  data,
  loading,
  onRetry,
}: {
  data: ChurnRiskKpiDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  const summary = data?.summary;
  const top = (data?.items ?? []).slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-amber-500" />
          Riesgo de baja
        </CardTitle>
        <CardDescription>Contratos con más probabilidad de cancelar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {() => (
            <>
              <div className="flex gap-3">
                <span className="flex-1 rounded-lg bg-red-500/10 px-3 py-2 text-center">
                  <span className="block text-xl font-semibold tabular-nums text-red-600">
                    {summary?.high ?? 0}
                  </span>
                  <span className="text-xs text-muted-foreground">Alto</span>
                </span>
                <span className="flex-1 rounded-lg bg-amber-500/10 px-3 py-2 text-center">
                  <span className="block text-xl font-semibold tabular-nums text-amber-600">
                    {summary?.medium ?? 0}
                  </span>
                  <span className="text-xs text-muted-foreground">Medio</span>
                </span>
                <span className="flex-1 rounded-lg bg-emerald-500/10 px-3 py-2 text-center">
                  <span className="block text-xl font-semibold tabular-nums text-emerald-600">
                    {summary?.low ?? 0}
                  </span>
                  <span className="text-xs text-muted-foreground">Bajo</span>
                </span>
              </div>

              {top.length === 0 ? (
                <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <ShieldCheck className="size-4 text-emerald-500" />
                  Ningún contrato en riesgo medio o alto.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {top.map((it) => (
                    <li
                      key={it.contractId}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <Link
                        href={`/contracts/${it.contractId}`}
                        className="min-w-0 flex-1 hover:underline"
                      >
                        <span className="block truncate font-medium">{it.customerName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {it.unitCode} · {eur(it.priceMonthly)}/mes · {it.factors[0] ?? ''}
                        </span>
                      </Link>
                      <Badge
                        variant="outline"
                        className={
                          it.level === 'high'
                            ? 'border-red-300 text-red-600'
                            : 'border-amber-300 text-amber-600'
                        }
                      >
                        {it.score}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/analytics?tab=churn-risk"
                className="block text-xs text-primary hover:underline"
              >
                Ver análisis completo →
              </Link>
            </>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
