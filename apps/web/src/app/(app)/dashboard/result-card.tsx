'use client';

import { Scale } from 'lucide-react';
import Link from 'next/link';

import type { DashboardResultDto } from '@storageos/shared';

import { Delta } from '@/app/(app)/analytics/period';
import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur } from '@/lib/format';

/** Lo que queda de lo facturado después de los gastos. */
export function ResultCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardResultDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="size-4 text-primary" />
          Resultado
        </CardTitle>
        <CardDescription>Facturado sin IVA menos gastos, en el periodo elegido.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(r) => (
            <div className="space-y-3">
              <p
                className={`text-3xl font-semibold tabular-nums ${r.net < 0 ? 'text-red-600' : ''}`}
              >
                {formatEur(r.net)}
              </p>
              <p className="text-xs">
                <Delta current={r.net} previous={r.previousNet} />
              </p>
              <ul className="divide-y text-sm">
                <li className="flex justify-between py-2">
                  <span>Facturado sin IVA</span>
                  <span className="tabular-nums">{formatEur(r.income)}</span>
                </li>
                <li className="flex justify-between py-2">
                  <span>Gastos</span>
                  <span className="tabular-nums">{formatEur(r.expenses)}</span>
                </li>
              </ul>
              <Link href="/expenses" className="block text-xs text-primary hover:underline">
                Ver gastos →
              </Link>
            </div>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
