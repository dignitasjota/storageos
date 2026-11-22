'use client';

import Link from 'next/link';

import type { AdminFinanceReconciliationDto } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatEur, plural } from '@/lib/format';

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  paypal: 'PayPal',
  other: 'Otro',
  manual: 'Manual',
  sepa: 'Remesa SEPA',
  redsys: 'Redsys',
};

/** Cobros sin factura y facturas sin cobro del periodo, uno a uno. */
export function ReconciliationCard({ r }: { r: AdminFinanceReconciliationDto }) {
  const { paymentsWithoutInvoice, invoicesWithoutPayment } = r;
  if (paymentsWithoutInvoice.count + invoicesWithoutPayment.count === 0) {
    return (
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Conciliación de cobros y facturas</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Todo cuadra: cada cobro del periodo tiene su factura y cada factura, su cobro.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="min-w-0 border-amber-300 dark:border-amber-900/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Conciliación de cobros y facturas</CardTitle>
        <p className="text-xs text-muted-foreground">
          {plural(paymentsWithoutInvoice.count, 'cobro sin factura', 'cobros sin factura')} (
          {formatEur(paymentsWithoutInvoice.total)}) ·{' '}
          {plural(invoicesWithoutPayment.count, 'factura sin cobro', 'facturas sin cobro')} (
          {formatEur(invoicesWithoutPayment.total)}), con IVA. Revísalos en la ficha del tenant o en{' '}
          <Link href="/admin/platform-invoices" className="underline">
            Facturas emitidas
          </Link>
          .
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <List
          title="Cobros sin factura"
          empty="Ninguno."
          rows={r.payments.map((p) => ({
            id: p.id,
            date: p.paidAt,
            tenantId: p.tenantId,
            tenantName: p.tenantName,
            ref: PROVIDER_LABELS[p.provider] ?? p.provider,
            amount: p.amount,
          }))}
          more={paymentsWithoutInvoice.count - r.payments.length}
        />
        <List
          title="Facturas sin cobro"
          empty="Ninguna."
          rows={r.invoices.map((i) => ({
            id: i.id,
            date: i.issuedAt,
            tenantId: i.tenantId,
            tenantName: i.tenantName,
            ref: i.fullNumber,
            amount: i.total,
          }))}
          more={invoicesWithoutPayment.count - r.invoices.length}
        />
      </CardContent>
    </Card>
  );
}

function List({
  title,
  empty,
  rows,
  more,
}: {
  title: string;
  empty: string;
  rows: {
    id: string;
    date: string;
    tenantId: string;
    tenantName: string;
    ref: string;
    amount: number;
  }[];
  more: number;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="max-h-72 divide-y overflow-y-auto rounded-md border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 p-2">
              <div className="min-w-0">
                <Link
                  href={`/admin/tenants/${row.tenantId}?tab=payments`}
                  className="block truncate hover:underline"
                >
                  {row.tenantName}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {formatDate(row.date)} · {row.ref}
                </p>
              </div>
              <span className="shrink-0 tabular-nums">{formatEur(row.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="text-xs text-muted-foreground">Y {more} más (descarga el CSV).</p>}
    </div>
  );
}
