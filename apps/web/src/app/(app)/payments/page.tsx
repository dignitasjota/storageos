'use client';

import { type PaymentDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { usePayments } from '@/lib/billing/hooks';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  processing: 'Procesando',
  succeeded: 'Cobrado',
  failed: 'Fallido',
  refunded: 'Reembolsado',
  partially_refunded: 'Reemb. parcial',
};
const METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  sepa_debit: 'SEPA',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  other: 'Otro',
};

export default function PaymentsPage() {
  const payments = usePayments();

  const columns: ColumnDef<PaymentDto>[] = [
    {
      accessorKey: 'createdAt',
      header: 'Fecha',
      cell: ({ row }) =>
        new Date(row.original.createdAt).toLocaleString('es-ES', {
          dateStyle: 'short',
          timeStyle: 'short',
        }),
    },
    {
      accessorKey: 'invoiceNumber',
      header: 'Factura',
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <Link
            href={`/invoices/${row.original.invoiceId}`}
            className="font-mono text-xs hover:underline"
          >
            {row.original.invoiceNumber ?? '—'}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { accessorKey: 'customerName', header: 'Cliente' },
    {
      accessorKey: 'amount',
      header: 'Importe',
      cell: ({ row }) =>
        row.original.amount.toLocaleString('es-ES', {
          style: 'currency',
          currency: row.original.currency,
        }),
    },
    {
      accessorKey: 'methodType',
      header: 'Método',
      cell: ({ row }) => METHOD_LABELS[row.original.methodType] ?? row.original.methodType,
    },
    { accessorKey: 'gateway', header: 'Gateway' },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.status === 'succeeded'
              ? 'default'
              : row.original.status === 'failed'
                ? 'destructive'
                : 'outline'
          }
        >
          {STATUS_LABELS[row.original.status] ?? row.original.status}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pagos</h1>
        <p className="text-sm text-muted-foreground">
          Cobros y reembolsos. La sincronización con Stripe llega vía webhook.
        </p>
      </div>
      <DataTable
        columns={columns}
        data={payments.data ?? []}
        isLoading={payments.isLoading}
        searchPlaceholder="Buscar..."
        emptyText="Aún no hay pagos registrados."
      />
    </div>
  );
}
