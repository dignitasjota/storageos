'use client';

import { Lock, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { CASE_STATUS_LABELS } from '@/app/(app)/collections/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useHasFeature } from '@/lib/auth/hooks';
import { useCollectionsSummary } from '@/lib/collections/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * Vista rápida de expedientes de impago ABIERTOS — complementa a «Hoy», que
 * solo muestra los que tienen el plazo del requerimiento ya vencido. Solo se
 * monta si el tenant tiene la feature `collections` (starter+/override).
 */
export function CollectionsSummaryCard() {
  const hasCollections = useHasFeature('collections');
  const q = useCollectionsSummary(hasCollections);

  if (!hasCollections) return null;

  const openCount = q.data?.openCount ?? 0;
  const totalDebt = q.data?.totalDebt ?? 0;
  const byStatus = q.data?.byStatus ?? {};
  const statusEntries = (Object.entries(byStatus) as [keyof typeof CASE_STATUS_LABELS, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="size-4 text-amber-500" />
          Impagos en gestión
        </CardTitle>
        <CardDescription>Expedientes de impago abiertos (overlock → disposición).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : openCount === 0 ? (
          <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-500" />
            Ningún expediente de impago abierto.
          </p>
        ) : (
          <>
            <div className="flex gap-3">
              <span className="flex-1 rounded-lg bg-amber-500/10 px-3 py-2 text-center">
                <span className="block text-xl font-semibold tabular-nums text-amber-600">
                  {openCount}
                </span>
                <span className="text-xs text-muted-foreground">
                  expediente{openCount === 1 ? '' : 's'} abierto{openCount === 1 ? '' : 's'}
                </span>
              </span>
              <span className="flex-1 rounded-lg bg-red-500/10 px-3 py-2 text-center">
                <span className="block text-xl font-semibold tabular-nums text-red-600">
                  {eur(totalDebt)}
                </span>
                <span className="text-xs text-muted-foreground">deuda en gestión</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {statusEntries.map(([status, count]) => (
                <Badge key={status} variant="outline" className="text-xs">
                  {CASE_STATUS_LABELS[status]} · {count}
                </Badge>
              ))}
            </div>
          </>
        )}
        <Link href="/collections" className="block text-xs text-primary hover:underline">
          Ver expedientes →
        </Link>
      </CardContent>
    </Card>
  );
}
