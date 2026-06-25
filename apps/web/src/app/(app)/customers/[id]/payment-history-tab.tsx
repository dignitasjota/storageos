'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import type { InvoiceDto, PaymentDto, PaymentMethodTypeValue } from '@storageos/shared';

import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useInvoices, usePayments } from '@/lib/billing/hooks';

function formatCurrency(value: number): string {
  return value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Mes legible a partir de una fecha de periodo (p. ej. "junio 2026"). */
function formatMonth(iso: string | null): string {
  if (!iso) return '—';
  const s = new Date(iso).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const METHOD_LABELS: Record<PaymentMethodTypeValue, string> = {
  card: 'Tarjeta',
  sepa_debit: 'SEPA',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  other: 'Otro',
};

const PAYMENT_STATUS: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  succeeded: { label: 'Cobrado', variant: 'default' },
  pending: { label: 'Pendiente', variant: 'secondary' },
  processing: { label: 'En proceso', variant: 'secondary' },
  failed: { label: 'Fallido', variant: 'destructive' },
  refunded: { label: 'Reembolsado', variant: 'outline' },
  partially_refunded: { label: 'Reemb. parcial', variant: 'outline' },
};

/** Puntualidad de una factura pagada: compara fecha de pago con vencimiento. */
function punctuality(
  inv: InvoiceDto,
): { label: string; variant: 'default' | 'destructive' | 'secondary'; days?: number } | null {
  if (inv.status !== 'paid' || !inv.paidAt || !inv.dueDate) return null;
  const paid = new Date(inv.paidAt);
  const due = new Date(inv.dueDate);
  // Comparar por día (el vencimiento es una fecha sin hora).
  const dueEnd = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 23, 59, 59);
  if (paid <= dueEnd) return { label: 'En plazo', variant: 'default' };
  const days = Math.ceil((paid.getTime() - dueEnd.getTime()) / 86_400_000);
  return { label: `+${days} d`, variant: 'destructive', days };
}

export function CustomerPaymentHistoryTab({ customerId }: { customerId: string }) {
  const invoicesQ = useInvoices({ customerId });
  const paymentsQ = usePayments({ customerId });

  const invoices = useMemo(
    () =>
      (invoicesQ.data ?? [])
        .filter((i) => i.status !== 'draft')
        .sort((a, b) =>
          (b.periodStart ?? b.issueDate ?? '').localeCompare(a.periodStart ?? a.issueDate ?? ''),
        ),
    [invoicesQ.data],
  );

  const payments = useMemo(
    () =>
      (paymentsQ.data ?? [])
        .slice()
        .sort((a, b) => (b.paidAt ?? b.createdAt).localeCompare(a.paidAt ?? a.createdAt)),
    [paymentsQ.data],
  );

  const summary = useMemo(() => {
    const all = invoicesQ.data ?? [];
    const totalPaid = all.reduce((s, i) => s + i.amountPaid, 0);
    const pending = all
      .filter((i) => i.status === 'issued' || i.status === 'overdue')
      .reduce((s, i) => s + i.amountPending, 0);
    const lateCount = all.filter((i) => {
      const p = punctuality(i);
      return p?.variant === 'destructive';
    }).length;

    // Meses pagados por adelantado: mes más lejano cubierto por una factura
    // pagada, respecto al mes actual.
    const now = new Date();
    let coveredUntil: Date | null = null;
    for (const i of all) {
      if (i.status !== 'paid' || !i.periodEnd) continue;
      const pe = new Date(i.periodEnd);
      if (!coveredUntil || pe > coveredUntil) coveredUntil = pe;
    }
    const monthsAhead = coveredUntil
      ? Math.max(
          0,
          (coveredUntil.getFullYear() - now.getFullYear()) * 12 +
            (coveredUntil.getMonth() - now.getMonth()),
        )
      : 0;

    return { totalPaid, pending, lateCount, monthsAhead, coveredUntil };
  }, [invoicesQ.data]);

  if (invoicesQ.isLoading || paymentsQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Resumen */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile label="Total pagado" value={formatCurrency(summary.totalPaid)} />
        <SummaryTile
          label="Pendiente de cobro"
          value={formatCurrency(summary.pending)}
          tone={summary.pending > 0 ? 'warning' : undefined}
        />
        <SummaryTile
          label="Pagado por adelantado"
          value={
            summary.monthsAhead > 0
              ? `${summary.monthsAhead} mes${summary.monthsAhead === 1 ? '' : 'es'}`
              : 'Al día'
          }
          hint={
            summary.monthsAhead > 0 && summary.coveredUntil
              ? `Cubierto hasta ${formatMonth(summary.coveredUntil.toISOString())}`
              : undefined
          }
          tone={summary.monthsAhead > 0 ? 'positive' : undefined}
        />
        <SummaryTile
          label="Pagos con retraso"
          value={String(summary.lateCount)}
          tone={summary.lateCount > 0 ? 'warning' : undefined}
        />
      </div>

      {/* Cargos mensuales (facturas) */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Cargos mensuales</h3>
        {invoices.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Este inquilino aún no tiene facturas emitidas.
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Factura</TableHead>
                  <TableHead>Periodo</TableHead>
                  <TableHead>Trastero · Local</TableHead>
                  <TableHead>Vencimiento</TableHead>
                  <TableHead className="text-right">Importe</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Pago</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((i) => {
                  const punc = punctuality(i);
                  return (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">
                          {i.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{i.periodStart ? formatMonth(i.periodStart) : '—'}</TableCell>
                      <TableCell className="text-sm">
                        {i.unitCode ? (
                          <>
                            {i.unitCode}
                            {i.facilityName && (
                              <span className="text-muted-foreground"> · {i.facilityName}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{formatDate(i.dueDate)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(i.total)}
                      </TableCell>
                      <TableCell>
                        <InvoiceStatusBadge status={i.status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {punc ? (
                          <span className="flex items-center gap-1.5">
                            <Badge variant={punc.variant}>{punc.label}</Badge>
                            <span className="text-muted-foreground">{formatDate(i.paidAt)}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Transacciones de cobro (payments) */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Transacciones de cobro</h3>
        {payments.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No hay cobros registrados todavía.
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Factura</TableHead>
                  <TableHead>Método</TableHead>
                  <TableHead className="text-right">Importe</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p: PaymentDto) => {
                  const st = PAYMENT_STATUS[p.status] ?? {
                    label: p.status,
                    variant: 'secondary' as const,
                  };
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">
                        {formatDate(p.paidAt ?? p.createdAt)}
                      </TableCell>
                      <TableCell>
                        {p.invoiceId ? (
                          <Link
                            href={`/invoices/${p.invoiceId}`}
                            className="font-medium hover:underline"
                          >
                            {p.invoiceNumber ?? '—'}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{METHOD_LABELS[p.methodType]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(p.amount)}
                        {p.refundedAmount > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            −{formatCurrency(p.refundedAmount)} reemb.
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'positive' | 'warning';
}) {
  const valueColor =
    tone === 'positive'
      ? 'text-green-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
