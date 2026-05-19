'use client';

import { type InvoiceDto, type InvoiceStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useState } from 'react';

import { DataTable } from '@/components/data-table';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInvoices } from '@/lib/billing/hooks';
import { useCustomers } from '@/lib/customers/hooks';

const STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  draft: 'Borrador',
  issued: 'Emitida',
  paid: 'Pagada',
  overdue: 'Vencida',
  cancelled: 'Cancelada',
  refunded: 'Reembolsada',
  partially_refunded: 'Reemb. parcial',
};

export default function InvoicesPage() {
  const [status, setStatus] = useState<InvoiceStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);

  const invoices = useInvoices({
    ...(status ? { status } : {}),
    ...(customerId ? { customerId } : {}),
    ...(overdueOnly ? { overdue: 'true' as const } : {}),
  });
  const customers = useCustomers();

  const columns: ColumnDef<InvoiceDto>[] = [
    {
      accessorKey: 'invoiceNumber',
      header: 'Número',
      cell: ({ row }) => (
        <Link href={`/invoices/${row.original.id}`} className="font-mono text-xs hover:underline">
          {row.original.invoiceNumber}
        </Link>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Cliente',
    },
    {
      accessorKey: 'issueDate',
      header: 'Emitida',
      cell: ({ row }) =>
        row.original.issueDate ? new Date(row.original.issueDate).toLocaleDateString('es-ES') : '—',
    },
    {
      accessorKey: 'dueDate',
      header: 'Vencimiento',
      cell: ({ row }) =>
        row.original.dueDate ? new Date(row.original.dueDate).toLocaleDateString('es-ES') : '—',
    },
    {
      accessorKey: 'total',
      header: 'Total',
      cell: ({ row }) =>
        row.original.total.toLocaleString('es-ES', {
          style: 'currency',
          currency: row.original.currency,
        }),
    },
    {
      accessorKey: 'amountPending',
      header: 'Pendiente',
      cell: ({ row }) =>
        row.original.amountPending > 0 ? (
          <span className="text-destructive tabular-nums">
            {row.original.amountPending.toLocaleString('es-ES', {
              style: 'currency',
              currency: row.original.currency,
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facturas</h1>
        <p className="text-sm text-muted-foreground">
          Listado de facturas emitidas y borradores. La numeración secuencial está reservada al
          emitir.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as InvoiceStatusValue))}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as InvoiceStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={customerId ?? 'all'}
          onValueChange={(v) => setCustomerId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[240px]">
            <SelectValue placeholder="Cliente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los clientes</SelectItem>
            {(customers.data ?? []).slice(0, 50).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={overdueOnly ? 'default' : 'outline'}
          onClick={() => setOverdueOnly((v) => !v)}
        >
          Solo vencidas
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={invoices.data ?? []}
        isLoading={invoices.isLoading}
        searchPlaceholder="Buscar..."
        emptyText="No hay facturas que coincidan."
      />
    </div>
  );
}
