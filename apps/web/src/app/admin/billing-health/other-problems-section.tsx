'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';

import type { BillingOtherProblemKind } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBillingOther } from '@/lib/admin/billing-domains-hooks';
import { formatDate } from '@/lib/format';

const KIND_LABEL: Record<BillingOtherProblemKind, string> = {
  first_invoice_failed: 'Primera factura sin emitir',
  platform_invoice_incomplete: 'Factura de suscripción incompleta',
  no_default_series: 'Sin serie por defecto',
  missing_fiscal_data: 'Sin datos fiscales',
};

/** Otros problemas de emisión que no pasan por la AEAT. */
export function OtherProblemsSection() {
  const other = useBillingOther();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Otros problemas de emisión</CardTitle>
        <CardDescription>
          Cosas que impiden o estropean la emisión de facturas aunque no lleguen a la AEAT.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {other.isError ? (
          <AdminError onRetry={() => void other.refetch()} />
        ) : other.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (other.data?.items ?? []).length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> No hay otros problemas.
          </p>
        ) : (
          (other.data?.items ?? []).map((p, i) => (
            <div key={`${p.kind}:${p.tenantId}:${i}`} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  {KIND_LABEL[p.kind]}
                </span>
                <Link href={p.link} className="font-medium hover:underline">
                  {p.tenantName ?? 'Plataforma'}
                </Link>
                {p.at && <span className="text-xs text-muted-foreground">{formatDate(p.at)}</span>}
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">{p.detail}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
