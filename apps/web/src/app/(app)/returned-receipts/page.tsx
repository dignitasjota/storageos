'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Download, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { ReturnedReceiptDto, ReturnedReceiptKind } from '@storageos/shared';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useReturnedReceipts } from '@/lib/billing/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities } from '@/lib/facilities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

const KIND_LABELS: Record<ReturnedReceiptKind, string> = {
  direct_debit_return: 'Domiciliación devuelta',
  sepa_rejected: 'Adeudo rechazado en remesa',
  chargeback: 'Contracargo de tarjeta',
  bank_return: 'Devolución bancaria',
};

const PERIODS = [
  { value: '30', label: 'Últimos 30 días' },
  { value: '90', label: 'Últimos 90 días' },
  { value: '365', label: 'Último año' },
  { value: 'year', label: 'Este año' },
];

function periodRange(value: string): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (value === 'year') return { from: `${now.getFullYear()}-01-01`, to };
  const from = new Date(now.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

const STATUS_LABELS: Record<string, string> = {
  paid: 'Cobrada de nuevo',
  issued: 'Pendiente',
  overdue: 'Vencida',
  cancelled: 'Anulada',
  rectified: 'Rectificada',
};

export default function ReturnedReceiptsPage() {
  const [period, setPeriod] = useState('90');
  const [kind, setKind] = useState('all');
  const [facilityId, setFacilityId] = useState('all');
  const facilities = useFacilities();
  const range = useMemo(() => periodRange(period), [period]);
  const query = useReturnedReceipts({
    ...range,
    ...(kind !== 'all' ? { kind } : {}),
    ...(facilityId !== 'all' ? { facilityId } : {}),
  });
  const data = query.data;

  const columns: ColumnDef<ReturnedReceiptDto>[] = [
    { header: 'Fecha', accessorKey: 'date', cell: ({ row }) => day(row.original.date) },
    {
      header: 'Tipo',
      accessorKey: 'kind',
      cell: ({ row }) => <Badge variant="outline">{KIND_LABELS[row.original.kind]}</Badge>,
    },
    {
      header: 'Inquilino',
      accessorKey: 'customerName',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName ?? '—'}
          </Link>
        ) : (
          (row.original.customerName ?? '—')
        ),
    },
    {
      header: 'Factura',
      accessorKey: 'invoiceNumber',
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <Link href={`/invoices/${row.original.invoiceId}`} className="hover:underline">
            {row.original.invoiceNumber}
          </Link>
        ) : (
          '—'
        ),
    },
    { header: 'Importe', accessorKey: 'amount', cell: ({ row }) => eur(row.original.amount) },
    {
      header: 'Motivo',
      accessorKey: 'reason',
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.reason ?? '—'}
          {row.original.remittanceName ? ` · ${row.original.remittanceName}` : ''}
        </span>
      ),
    },
    {
      header: 'Situación',
      accessorKey: 'invoiceStatus',
      cell: ({ row }) => {
        const r = row.original;
        if (r.invoicePending > 0)
          return <span className="text-destructive">Pendiente {eur(r.invoicePending)}</span>;
        return (
          <span className="text-muted-foreground">
            {r.invoiceStatus ? (STATUS_LABELS[r.invoiceStatus] ?? r.invoiceStatus) : '—'}
          </span>
        );
      },
    },
  ];

  function exportCsv() {
    if (!data) return;
    downloadCsv(`recibos-devueltos-${data.from}-${data.to}.csv`, [
      [
        'Fecha',
        'Tipo',
        'Inquilino',
        'Factura',
        'Local',
        'Importe',
        'Motivo',
        'Remesa',
        'Pendiente',
      ],
      ...data.items.map((i) => [
        day(i.date),
        KIND_LABELS[i.kind],
        i.customerName ?? '',
        i.invoiceNumber ?? '',
        i.facilityName ?? '',
        i.amount.toFixed(2).replace('.', ','),
        i.reason ?? '',
        i.remittanceName ?? '',
        i.invoicePending.toFixed(2).replace('.', ','),
      ]),
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Undo2 className="size-6" />
            Recibos devueltos
          </h1>
          <p className="text-sm text-muted-foreground">
            Cobros que el banco o la tarjeta devolvieron después de cobrarse y adeudos rechazados al
            confirmar una remesa SEPA.
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!data || data.items.length === 0}>
          <Download className="mr-1 size-4" />
          Exportar a Excel
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {(Object.keys(KIND_LABELS) as ReturnedReceiptKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(facilities.data?.length ?? 0) > 1 && (
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger aria-label="Local">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {facilities.data!.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Recibos devueltos</p>
              <p className="text-2xl font-semibold">{data.totals.count}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Importe devuelto</p>
              <p className="text-2xl font-semibold">{eur(data.totals.amount)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Sigue sin cobrar</p>
              <p className="text-2xl font-semibold text-destructive">
                {eur(data.totals.stillPending)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        isLoading={query.isLoading}
        searchPlaceholder="Buscar inquilino o factura..."
        emptyText="No hay recibos devueltos en este periodo."
      />
    </div>
  );
}
