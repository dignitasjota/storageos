'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Download, MoreHorizontal, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { ReturnedReceiptDto, ReturnedReceiptKind } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useApplyReturnFee,
  useBulkChargeInvoices,
  useBulkRemindInvoices,
  useReturnedReceipts,
} from '@/lib/billing/hooks';
import { downloadCsv } from '@/lib/csv';
import { localDateString } from '@/lib/dates';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate, formatEur } from '@/lib/format';

const eur = formatEur;
const day = (iso: string) => formatDate(iso);

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
  const to = localDateString(now);
  if (value === 'year') return { from: `${now.getFullYear()}-01-01`, to };
  const from = localDateString(new Date(now.getTime() - Number(value) * 86_400_000));
  return { from, to };
}

/** Una factura que aún se puede cobrar o reclamar. */
const PAYABLE = new Set(['issued', 'overdue']);

const STATUS_LABELS: Record<string, string> = {
  paid: 'Cobrada de nuevo',
  issued: 'Pendiente',
  overdue: 'Vencida',
  cancelled: 'Anulada',
  rectified: 'Rectificada',
  refunded: 'Devuelta al inquilino',
  partially_refunded: 'Devuelta en parte',
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
  const ask = useConfirm();
  const charge = useBulkChargeInvoices();
  const remind = useBulkRemindInvoices();
  const applyFee = useApplyReturnFee();
  const canCharge = useHasPermission('payments:charge');
  const canRemind = useHasPermission('communications:send');
  const canManage = useHasPermission('invoices:manage');
  const [repeatOnly, setRepeatOnly] = useState(false);
  const items = useMemo(
    () => (data?.items ?? []).filter((i) => !repeatOnly || i.customerReturns12m >= 2),
    [data, repeatOnly],
  );

  async function chargeAgain(r: ReturnedReceiptDto) {
    if (!r.invoiceId) return;
    if (
      !(await ask({
        title: `¿Volver a cobrar ${eur(r.invoicePending)} a ${r.customerName ?? 'este inquilino'}?`,
        description: 'Se cobra con la tarjeta o la domiciliación que tiene guardada.',
      }))
    )
      return;
    try {
      const res = await charge.mutateAsync([r.invoiceId]);
      if (res.succeeded.length) toast.success(`Cobro de ${r.invoiceNumber} lanzado.`);
      else toast.error(res.failed[0]?.error ?? 'No se pudo cobrar.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cobrar.');
    }
  }
  async function remindOne(r: ReturnedReceiptDto) {
    if (!r.invoiceId) return;
    try {
      const res = await remind.mutateAsync([r.invoiceId]);
      if (res.succeeded.length) toast.success(`Recordatorio enviado a ${r.customerName ?? ''}.`);
      else toast.error(res.failed[0]?.error ?? 'No se ha enviado el recordatorio.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }
  async function fee(r: ReturnedReceiptDto) {
    if (!r.invoiceId || !data?.returnFee) return;
    if (
      !(await ask({
        title: `¿Cargar ${eur(data.returnFee)} de gastos por esta devolución?`,
        description: `Se emite una factura aparte a ${r.customerName ?? 'el inquilino'}, sin IVA, como dice su contrato.`,
      }))
    )
      return;
    try {
      const invoice = await applyFee.mutateAsync({ invoiceId: r.invoiceId, sourceId: r.id });
      toast.success(`Gastos cargados en la factura ${invoice.invoiceNumber}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron cargar.');
    }
  }

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
      cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.original.customerId ? (
            <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
              {row.original.customerName ?? '—'}
            </Link>
          ) : (
            (row.original.customerName ?? '—')
          )}
          {row.original.customerReturns12m >= 2 && (
            <Badge
              variant="destructive"
              title={`${row.original.customerReturns12m} devoluciones en los últimos 12 meses`}
            >
              Reincidente · {row.original.customerReturns12m}
            </Badge>
          )}
        </span>
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
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const payable = r.invoicePending > 0 && PAYABLE.has(r.invoiceStatus ?? '');
        const options = [
          canCharge && payable && r.chargeable && (
            <DropdownMenuItem key="charge" onSelect={() => void chargeAgain(r)}>
              Volver a cobrar con su método guardado
            </DropdownMenuItem>
          ),
          canRemind && payable && (
            <DropdownMenuItem key="remind" onSelect={() => void remindOne(r)}>
              Enviarle un recordatorio
            </DropdownMenuItem>
          ),
          canManage && data?.returnFee && r.customerId && !r.returnFeeInvoiceId && (
            <DropdownMenuItem key="fee" onSelect={() => void fee(r)}>
              Cargar los gastos de devolución ({eur(data.returnFee)})
            </DropdownMenuItem>
          ),
          r.returnFeeInvoiceId && (
            <DropdownMenuItem key="fee-invoice" asChild>
              <Link href={`/invoices/${r.returnFeeInvoiceId}`}>Ver la factura de gastos</Link>
            </DropdownMenuItem>
          ),
        ].filter(Boolean);
        if (options.length === 0) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{options}</DropdownMenuContent>
          </DropdownMenu>
        );
      },
      meta: { mobileLabel: 'Acciones' },
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
        'Código',
        'Remesa',
        'Pendiente',
        'Devoluciones en 12 meses',
      ],
      ...data.items.map((i) => [
        day(i.date),
        KIND_LABELS[i.kind],
        i.customerName ?? '',
        i.invoiceNumber ?? '',
        i.facilityName ?? '',
        i.amount.toFixed(2).replace('.', ','),
        i.reason ?? '',
        i.returnCode ?? '',
        i.remittanceName ?? '',
        i.invoicePending.toFixed(2).replace('.', ','),
        i.customerReturns12m,
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
          Exportar CSV
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Reincidentes</p>
              <p className="text-2xl font-semibold">{data.totals.repeatCustomers}</p>
              <p className="text-xs text-muted-foreground">
                Inquilinos con 2 o más devoluciones en 12 meses
              </p>
              {data.totals.repeatCustomers > 0 && (
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={repeatOnly}
                    onChange={(e) => setRepeatOnly(e.target.checked)}
                  />
                  Ver solo los reincidentes
                </label>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {data && !data.returnFee && canManage && (
        <p className="text-xs text-muted-foreground">
          Si tu contrato cobra gastos por recibo devuelto, ponlos en{' '}
          <Link href="/settings/contract-template" className="underline underline-offset-2">
            Plantilla de contrato
          </Link>{' '}
          y podrás cargarlos desde aquí.
        </p>
      )}

      {query.isError ? (
        <SectionError onRetry={() => void query.refetch()} />
      ) : (
        <DataTable
          rowHref={(r) => (r.invoiceId ? `/invoices/${r.invoiceId}` : null)}
          columns={columns}
          data={items}
          isLoading={query.isLoading}
          searchPlaceholder="Buscar inquilino, factura, local o motivo..."
          searchText={(r) =>
            [
              r.customerName,
              r.invoiceNumber,
              r.facilityName,
              r.reason,
              r.remittanceName,
              KIND_LABELS[r.kind],
            ]
              .filter(Boolean)
              .join(' ')
          }
          emptyText="No hay recibos devueltos en este periodo."
        />
      )}
    </div>
  );
}
