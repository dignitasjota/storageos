'use client';

import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { InvoiceDto, PaymentDto, PaymentMethodTypeValue } from '@storageos/shared';

import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
          <>
            {/* Escritorio (lg+): tabla completa (8 columnas). */}
            <div className="hidden overflow-x-auto rounded-md border lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Factura</TableHead>
                    <TableHead>Concepto</TableHead>
                    <TableHead>Trastero · Local</TableHead>
                    <TableHead>Vencimiento</TableHead>
                    <TableHead className="text-right">Importe</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Pago</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((i) => (
                    <InvoiceRow key={i.id} invoice={i} />
                  ))}
                </TableBody>
              </Table>
            </div>
            {/* Móvil/tablet: tarjetas apiladas (se ven de un vistazo, sin scroll). */}
            <div className="space-y-2 lg:hidden">
              {invoices.map((i) => (
                <InvoiceCard key={i.id} invoice={i} />
              ))}
            </div>
          </>
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
          <>
            {/* Escritorio (md+): tabla. */}
            <div className="hidden overflow-x-auto rounded-md border md:block">
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
            {/* Móvil: tarjetas. */}
            <div className="space-y-2 md:hidden">
              {payments.map((p: PaymentDto) => (
                <PaymentCard key={p.id} payment={p} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Trastero · local de una factura, con enlaces (compartido por la tabla y la
 *  tarjeta móvil). Devuelve "—" si la factura no está anclada a una unidad. */
function unitFacility(i: InvoiceDto) {
  if (!i.unitCode) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {i.unitId ? (
        <Link href={`/units/${i.unitId}`} className="hover:underline">
          {i.unitCode}
        </Link>
      ) : (
        i.unitCode
      )}
      {i.facilityName &&
        (i.facilityId ? (
          <span className="text-muted-foreground">
            {' · '}
            <Link href={`/facilities/${i.facilityId}`} className="hover:underline">
              {i.facilityName}
            </Link>
          </span>
        ) : (
          <span className="text-muted-foreground"> · {i.facilityName}</span>
        ))}
    </>
  );
}

/** Concepto legible de una factura, derivado de sus campos y líneas. */
function invoiceConcept(inv: InvoiceDto): {
  badge: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  detail: string;
} {
  if (inv.lateFeeForInvoiceId) {
    return { badge: 'Recargo', variant: 'destructive', detail: 'Recargo por mora' };
  }
  if (inv.contractId || inv.periodStart) {
    const hasInsurance = inv.items.some((it) => /protecci|seguro/i.test(it.description));
    const month = inv.periodStart ? formatMonth(inv.periodStart) : 'Alquiler';
    return {
      badge: 'Alquiler',
      variant: 'secondary',
      detail: hasInsurance ? `${month} · incluye protección` : month,
    };
  }
  const first = inv.items[0];
  return { badge: 'Producto', variant: 'outline', detail: first?.description ?? 'Venta' };
}

function InvoiceRow({ invoice: i }: { invoice: InvoiceDto }) {
  const [open, setOpen] = useState(false);
  const punc = punctuality(i);
  const concept = invoiceConcept(i);
  return (
    <>
      <TableRow>
        <TableCell className="pr-0">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Contraer' : 'Ver líneas'}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        </TableCell>
        <TableCell>
          <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">
            {i.invoiceNumber}
          </Link>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <Badge variant={concept.variant}>{concept.badge}</Badge>
            <span className="text-sm text-muted-foreground">{concept.detail}</span>
          </div>
        </TableCell>
        <TableCell className="text-sm">{unitFacility(i)}</TableCell>
        <TableCell className="text-sm">{formatDate(i.dueDate)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatCurrency(i.total)}</TableCell>
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
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={7} className="py-2">
            {i.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sin líneas de detalle.</p>
            ) : (
              <ul className="space-y-1">
                {i.items.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">
                      {it.quantity > 1 && `${it.quantity} × `}
                      {it.description}
                    </span>
                    <span className="tabular-nums">{formatCurrency(it.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Versión en tarjeta de un cargo (factura), para móvil/tablet: muestra la misma
 *  información que la fila de la tabla pero apilada, sin scroll horizontal. */
function InvoiceCard({ invoice: i }: { invoice: InvoiceDto }) {
  const [open, setOpen] = useState(false);
  const punc = punctuality(i);
  const concept = invoiceConcept(i);
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">
          {i.invoiceNumber}
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-medium tabular-nums">{formatCurrency(i.total)}</span>
          <InvoiceStatusBadge status={i.status} />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={concept.variant}>{concept.badge}</Badge>
        <span className="text-muted-foreground">{concept.detail}</span>
      </div>
      {i.unitCode && <p className="mt-1 text-muted-foreground">{unitFacility(i)}</p>}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Vence: {formatDate(i.dueDate)}</span>
        {punc && (
          <span className="flex items-center gap-1.5">
            <Badge variant={punc.variant}>{punc.label}</Badge>
            {formatDate(i.paidAt)}
          </span>
        )}
      </div>
      {i.items.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {open ? 'Ocultar líneas' : 'Ver líneas'}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1 border-t pt-1.5">
              {i.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {it.quantity > 1 && `${it.quantity} × `}
                    {it.description}
                  </span>
                  <span className="tabular-nums">{formatCurrency(it.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Versión en tarjeta de una transacción de cobro (payment), para móvil. */
function PaymentCard({ payment: p }: { payment: PaymentDto }) {
  const st = PAYMENT_STATUS[p.status] ?? { label: p.status, variant: 'secondary' as const };
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium tabular-nums">{formatCurrency(p.amount)}</span>
        <Badge variant={st.variant}>{st.label}</Badge>
      </div>
      {p.refundedAmount > 0 && (
        <p className="text-xs text-muted-foreground">
          −{formatCurrency(p.refundedAmount)} reembolsado
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {formatDate(p.paidAt ?? p.createdAt)} · {METHOD_LABELS[p.methodType]}
        </span>
        {p.invoiceId && (
          <Link href={`/invoices/${p.invoiceId}`} className="font-medium hover:underline">
            {p.invoiceNumber ?? '—'}
          </Link>
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
