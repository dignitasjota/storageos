'use client';

import Link from 'next/link';

import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useInvoices } from '@/lib/billing/hooks';
import { invoiceNumberLabel, isNumbered } from '@/lib/billing/labels';
import { useContractAccount } from '@/lib/customers/hooks';
import { formatDate, formatEur } from '@/lib/format';

/** Lo que debe el contrato, lo que viene y sus facturas. */
export function ContractBillingTab({
  contractId,
  creditBalance = 0,
}: {
  contractId: string;
  /** Saldo a favor del inquilino en este contrato (una devolución que no salió). */
  creditBalance?: number;
}) {
  const account = useContractAccount(contractId);
  const invoices = useInvoices({ contractId });
  const a = account.data;
  // Los borradores no, salvo el primer pago (se emite, con su número, al cobrarse).
  const rows = (invoices.data ?? []).filter((i) => i.status !== 'draft' || i.issueOnPayment);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Figure label="Pendiente" value={a ? formatEur(a.pendingAmount) : '…'}>
          {a && a.overdueAmount > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {formatEur(a.overdueAmount)} vencido
            </span>
          )}
        </Figure>
        <Figure label="Cobrado" value={a ? formatEur(a.paidAmount) : '…'} />
        <Figure
          label="Próxima factura"
          value={a?.nextInvoice ? formatEur(a.nextInvoice.amount) : '—'}
        >
          {a?.nextInvoice ? `Hacia el ${formatDate(a.nextInvoice.date)}, sin IVA` : null}
        </Figure>
      </div>
      {creditBalance > 0 && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          Tiene <span className="font-medium tabular-nums">{formatEur(creditBalance)}</span> de
          saldo a favor: se descuentan de su próxima factura al emitirla.
        </p>
      )}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Facturas del contrato</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no tiene facturas.</p>
          ) : (
            <ul className="divide-y text-sm">
              {rows.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link
                    href={`/invoices/${i.id}`}
                    className={
                      isNumbered(i)
                        ? 'font-mono text-xs hover:underline'
                        : 'text-xs italic hover:underline'
                    }
                  >
                    {invoiceNumberLabel(i)}
                    {i.kind === 'deposit_receipt' ? ' · fianza' : ''}
                  </Link>
                  <span className="text-muted-foreground">
                    {i.issueDate
                      ? formatDate(i.issueDate)
                      : i.dueDate
                        ? `Pagar antes del ${formatDate(i.dueDate)}`
                        : '—'}
                  </span>
                  <span className="tabular-nums">{formatEur(i.total)}</span>
                  <InvoiceStatusBadge
                    status={i.status}
                    total={i.total}
                    voided={!!i.voidedAt}
                    awaitingPayment={i.issueOnPayment}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {children && <p className="text-xs text-muted-foreground">{children}</p>}
      </CardContent>
    </Card>
  );
}
