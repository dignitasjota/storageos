'use client';

import {
  InvoiceStatusEnum,
  type BulkInvoiceActionResultDto,
  type InvoiceDto,
  type InvoicePaymentFilterValue,
  type InvoiceSavedViewDto,
  type InvoiceSortValue,
  type InvoiceStatusValue,
  type InvoiceTypeFilterValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Bookmark, CalendarCheck, Download, Loader2, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { NewInvoiceDialog } from './new-invoice-dialog';

import { Can } from '@/components/auth/can';
import { InvoiceCollectionBadges } from '@/components/billing/invoice-collection-badges';
import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { INVOICE_STATUS_LABELS, InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { toastBulkResult } from '@/lib/billing/bulk-report';
import {
  fetchAllInvoices,
  useBulkChargeInvoices,
  useBulkIssueInvoices,
  useBulkRemindInvoices,
  useDeleteInvoiceView,
  useInvoiceTotals,
  useInvoiceViews,
  useSaveInvoiceView,
  type InvoiceListParams,
} from '@/lib/billing/hooks';
import { invoiceNumberLabel, isNumbered } from '@/lib/billing/labels';
import { downloadCsv } from '@/lib/csv';
import { localDateString } from '@/lib/dates';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';
import { useOpenFromUrl } from '@/lib/use-open-from-url';

const TYPE_LABELS: Record<InvoiceTypeFilterValue, string> = {
  F1: 'Completas',
  F2: 'Simplificadas',
  R: 'Rectificativas',
  deposit: 'Justificantes de fianza',
};

const PAYMENT_LABELS: Record<InvoicePaymentFilterValue, string> = {
  card: 'Cobradas con tarjeta',
  sepa_debit: 'Cobradas por domiciliación',
  bank_transfer: 'Cobradas por transferencia',
  cash: 'Cobradas en efectivo',
  other: 'Cobradas de otra forma',
  none: 'Pendientes sin forma de pago guardada',
};

const SORT_LABELS: Record<InvoiceSortValue, string> = {
  newest: 'Más recientes primero',
  oldest: 'Más antiguas primero',
  due: 'Por fecha de vencimiento',
  amount: 'Por importe (de mayor a menor)',
};

type PeriodKey = 'all' | 'this_month' | 'last_month' | 'this_year' | 'last_year' | 'custom';
const PERIOD_LABELS: Record<PeriodKey, string> = {
  all: 'Cualquier fecha',
  this_month: 'Emitidas este mes',
  last_month: 'Emitidas el mes pasado',
  this_year: 'Emitidas este año',
  last_year: 'Emitidas el año pasado',
  custom: 'Emitidas entre dos fechas',
};

/** Desde y hasta (fecha de emisión) de un periodo. */
function periodRange(key: PeriodKey, from?: string, to?: string): { from?: string; to?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case 'this_month':
      return { from: localDateString(new Date(y, m, 1)) };
    case 'last_month':
      return {
        from: localDateString(new Date(y, m - 1, 1)),
        to: localDateString(new Date(y, m, 0)),
      };
    case 'this_year':
      return { from: `${y}-01-01` };
    case 'last_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'custom':
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    default:
      return {};
  }
}

function typeLabel(i: InvoiceDto): string {
  if (i.kind === 'deposit_receipt') return 'Fianza';
  if (i.invoiceType === 'F2') return 'Simplificada';
  if (i.invoiceType.startsWith('R')) return 'Rectificativa';
  return i.lateFeeForInvoiceId ? 'Recargo' : 'Completa';
}

/** Lo cobrado, como en la ficha: sin la retención ni lo saldado con un abono. */
function collectedOf(i: InvoiceDto): number {
  const value = i.amountPaid - i.withholdingAmount - i.amountCompensated;
  return Math.max(0, Math.round(value * 100) / 100);
}

export default function InvoicesPage() {
  const ask = useConfirm();
  const [status, setStatus] = useState<InvoiceStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [type, setType] = useState<InvoiceTypeFilterValue | undefined>();
  const [payment, setPayment] = useState<InvoicePaymentFilterValue | undefined>();
  const [sort, setSort] = useState<InvoiceSortValue>('newest');
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customFrom, setCustomFrom] = useState<string | undefined>();
  const [customTo, setCustomTo] = useState<string | undefined>();
  // En el móvil, la fecha, el tipo, la forma de pago y el orden van plegados.
  const [moreFilters, setMoreFilters] = useState(false);
  const secondaryActive =
    (period !== 'all' ? 1 : 0) + (type ? 1 : 0) + (payment ? 1 : 0) + (sort !== 'newest' ? 1 : 0);
  // Enlaces con filtro (`/invoices?status=overdue` desde «Hoy» o las sugerencias).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    const parsed = InvoiceStatusEnum.safeParse(s);
    if (parsed.success) {
      setStatus(parsed.data);
    }
  }, []);

  const [createOpen, setCreateOpen] = useState(false);
  useOpenFromUrl(() => setCreateOpen(true));

  const headerFacilityId = useHeaderFacilityId();
  const [searchText, search, setSearchText] = useDebouncedSearch();
  const range = periodRange(period, customFrom, customTo);
  // Los mismos filtros para la lista, los totales, el CSV y las vistas.
  const filterParams: InvoiceListParams = {
    facilityId: headerFacilityId,
    status,
    customerId,
    overdue: overdueOnly ? 'true' : undefined,
    search: search || undefined,
    type,
    payment,
    from: range.from,
    to: range.to,
  };
  const invoices = usePagedList<InvoiceDto>('invoices', '/invoices', {
    ...filterParams,
    sort: sort === 'newest' ? undefined : sort,
  });
  const totals = useInvoiceTotals(filterParams);
  const views = useInvoiceViews();
  const saveView = useSaveInvoiceView();
  const deleteView = useDeleteInvoiceView();
  const bulkIssue = useBulkIssueInvoices();
  const bulkCharge = useBulkChargeInvoices();
  const bulkRemind = useBulkRemindInvoices();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // Al cambiar los filtros, lo seleccionado deja de verse: se suelta.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    status,
    customerId,
    overdueOnly,
    search,
    headerFacilityId,
    type,
    payment,
    period,
    customFrom,
    customTo,
  ]);

  const filtersActive =
    !!status ||
    !!customerId ||
    overdueOnly ||
    !!type ||
    !!payment ||
    period !== 'all' ||
    sort !== 'newest';

  function clearFilters(): void {
    setStatus(undefined);
    setCustomerId(undefined);
    setOverdueOnly(false);
    setType(undefined);
    setPayment(undefined);
    setSort('newest');
    setPeriod('all');
    setCustomFrom(undefined);
    setCustomTo(undefined);
  }

  /** Lo que se guarda de una vista: solo los filtros puestos. */
  function currentFilters(): Record<string, string> {
    const f: Record<string, string> = {};
    if (status) f.status = status;
    if (customerId) f.customerId = customerId;
    if (overdueOnly) f.overdue = 'true';
    if (type) f.type = type;
    if (payment) f.payment = payment;
    if (sort !== 'newest') f.sort = sort;
    if (period !== 'all') f.period = period;
    if (period === 'custom' && customFrom) f.from = customFrom;
    if (period === 'custom' && customTo) f.to = customTo;
    return f;
  }

  function applyView(view: InvoiceSavedViewDto): void {
    const f = view.filters as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
    const parsedStatus = InvoiceStatusEnum.safeParse(str('status'));
    setStatus(parsedStatus.success ? parsedStatus.data : undefined);
    setCustomerId(str('customerId'));
    setOverdueOnly(str('overdue') === 'true');
    const t = str('type');
    setType(t && t in TYPE_LABELS ? (t as InvoiceTypeFilterValue) : undefined);
    const p = str('payment');
    setPayment(p && p in PAYMENT_LABELS ? (p as InvoicePaymentFilterValue) : undefined);
    const s = str('sort');
    setSort(s && s in SORT_LABELS ? (s as InvoiceSortValue) : 'newest');
    const per = str('period');
    setPeriod(per && per in PERIOD_LABELS ? (per as PeriodKey) : 'all');
    setCustomFrom(str('from'));
    setCustomTo(str('to'));
    toast.success(`Vista «${view.name}» aplicada.`);
  }

  async function onSaveView(): Promise<void> {
    const res = await ask({
      title: 'Guardar esta vista',
      description:
        'Se guardan los filtros y el orden que tienes puestos. La ve todo el equipo; con el mismo nombre se sustituye.',
      confirmLabel: 'Guardar',
      input: { label: 'Nombre', placeholder: 'Vencidas de este mes', required: true },
    });
    if (!res) return;
    try {
      await saveView.mutateAsync({ name: res.value.slice(0, 60), filters: currentFilters() });
      toast.success('Vista guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  async function onDeleteView(view: InvoiceSavedViewDto): Promise<void> {
    if (
      !(await ask({
        title: `¿Borrar la vista «${view.name}»?`,
        description: 'Desaparece para todo el equipo. Las facturas no cambian.',
        confirmLabel: 'Borrar',
        destructive: true,
      }))
    )
      return;
    try {
      await deleteView.mutateAsync(view.id);
      toast.success('Vista borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido borrar.');
    }
  }

  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const { rows: all, truncated } = await fetchAllInvoices({
        ...filterParams,
        sort: sort === 'newest' ? undefined : sort,
      });
      downloadCsv(`facturas-${localDateString()}.csv`, [
        [
          'Número',
          'Tipo',
          'Cliente',
          'Contrato',
          'Trastero',
          'Local',
          'Emitida',
          'Vence',
          'Base',
          'IVA',
          'Total',
          'Cobrado',
          'Devuelto',
          'Pendiente',
          'Estado',
        ],
        ...all.map((i) => [
          invoiceNumberLabel(i),
          typeLabel(i),
          i.customerName ?? 'Sin identificar',
          i.contractNumber ?? '',
          i.unitCode ?? '',
          i.facilityName ?? '',
          isNumbered(i) ? formatDate(i.issueDate) : '',
          i.dueDate ? formatDate(i.dueDate) : '',
          i.subtotal,
          i.taxAmount,
          i.total,
          collectedOf(i),
          i.amountRefunded,
          i.amountPending,
          INVOICE_STATUS_LABELS[i.status] ?? i.status,
        ]),
      ]);
      if (truncated) {
        toast.info('Se han exportado las 5.000 primeras. Acota con los filtros para el resto.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido exportar.');
    } finally {
      setExporting(false);
    }
  }

  const rows = invoices.rows;
  const selectableDraft = rows.filter((i) => i.status === 'draft').map((i) => i.id);
  const selectableChargeable = rows
    .filter((i) => (i.status === 'issued' || i.status === 'overdue') && i.amountPending > 0)
    .map((i) => i.id);
  const selectable = [...selectableDraft, ...selectableChargeable];
  const selectedList = [...selectedIds];
  const selectedDraft = selectedList.filter((id) => selectableDraft.includes(id));
  const selectedChargeable = selectedList.filter((id) => selectableChargeable.includes(id));
  const allSelected = selectable.length > 0 && selectable.every((id) => selectedIds.has(id));
  const pendingOfSelected = rows
    .filter((i) => selectedChargeable.includes(i.id))
    .reduce((sum, i) => sum + i.amountPending, 0);

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reportBulk(res: BulkInvoiceActionResultDto, done: string, processingNote?: string) {
    setSelectedIds(new Set());
    toastBulkResult(res, done, processingNote);
  }

  async function onBulkIssue() {
    if (
      !(await ask({
        title: `¿Emitir ${selectedDraft.length} ${selectedDraft.length === 1 ? 'borrador' : 'borradores'}?`,
        description:
          'Cada factura recibe su número y se registra en Veri*Factu. Después ya no se puede borrar, solo rectificar.',
        confirmLabel: 'Emitir',
      }))
    )
      return;
    try {
      reportBulk(await bulkIssue.mutateAsync(selectedDraft), 'emitidas');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido emitir.');
    }
  }
  async function onBulkCharge() {
    if (
      !(await ask({
        title: `¿Cobrar ${selectedChargeable.length} ${selectedChargeable.length === 1 ? 'factura' : 'facturas'} (${formatEur(pendingOfSelected)})?`,
        description:
          'Se cobra a cada inquilino con su tarjeta o domiciliación guardada. Las que no tengan forma de pago se quedan sin cobrar.',
        confirmLabel: 'Cobrar',
      }))
    )
      return;
    try {
      reportBulk(
        await bulkCharge.mutateAsync(selectedChargeable),
        'cobradas',
        'por domiciliación (el banco las confirma en 2-5 días)',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido cobrar.');
    }
  }
  async function onBulkRemind() {
    if (
      !(await ask({
        title: `¿Enviar un recordatorio de pago a ${selectedChargeable.length} ${selectedChargeable.length === 1 ? 'inquilino' : 'inquilinos'}?`,
        description:
          'Les llega un correo con lo que deben y el enlace para pagar; si alguien debe varias, todas van en el mismo correo. A quien ya recibió uno hoy no se le envía otro.',
        confirmLabel: 'Enviar',
      }))
    )
      return;
    try {
      reportBulk(await bulkRemind.mutateAsync(selectedChargeable), 'recordatorios enviados');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar.');
    }
  }

  const columns: ColumnDef<InvoiceDto>[] = [
    {
      id: 'select',
      header: () => (
        <Checkbox
          checked={allSelected}
          aria-label="Seleccionar todas"
          onCheckedChange={(v) => setSelectedIds(v ? new Set(selectable) : new Set())}
        />
      ),
      cell: ({ row }) => {
        const i = row.original;
        if (!selectable.includes(i.id)) return null;
        return (
          <Checkbox
            checked={selectedIds.has(i.id)}
            aria-label={`Seleccionar ${invoiceNumberLabel(i)} de ${i.customerName ?? 'cliente sin identificar'}`}
            onCheckedChange={() => toggleRow(i.id)}
          />
        );
      },
    },
    {
      accessorKey: 'invoiceNumber',
      header: 'Número',
      cell: ({ row }) => {
        const i = row.original;
        return (
          <span className="flex flex-wrap items-center justify-end gap-1.5 md:justify-start">
            <Link
              href={`/invoices/${i.id}`}
              className={
                isNumbered(i)
                  ? 'font-mono text-xs hover:underline'
                  : 'text-xs italic text-muted-foreground hover:underline'
              }
            >
              {invoiceNumberLabel(i)}
            </Link>
            {i.kind === 'deposit_receipt' && (
              <Badge variant="outline" title="Justificante de fianza: no es una factura">
                Fianza
              </Badge>
            )}
            {i.invoiceType === 'F2' && <Badge variant="outline">Simplificada</Badge>}
            {i.invoiceType.startsWith('R') && <Badge variant="outline">Rectificativa</Badge>}
            {i.lateFeeForInvoiceId && <Badge variant="outline">Recargo</Badge>}
            <InvoiceCollectionBadges invoice={i} compact />
          </span>
        );
      },
    },
    {
      accessorKey: 'customerName',
      header: 'Cliente',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName ?? 'Cliente'}
          </Link>
        ) : (
          <span className="italic text-muted-foreground">Sin identificar</span>
        ),
    },
    {
      accessorKey: 'issueDate',
      header: 'Emitida',
      meta: { mobileHidden: true },
      cell: ({ row }) => (isNumbered(row.original) ? formatDate(row.original.issueDate) : '—'),
    },
    {
      accessorKey: 'dueDate',
      header: 'Vence',
      cell: ({ row }) => formatDate(row.original.dueDate),
    },
    {
      accessorKey: 'total',
      header: 'Total',
      cell: ({ row }) => <span className="tabular-nums">{formatEur(row.original.total)}</span>,
    },
    {
      accessorKey: 'amountPending',
      header: 'Pendiente',
      cell: ({ row }) =>
        row.original.amountPending > 0 ? (
          <span className="text-destructive tabular-nums">
            {formatEur(row.original.amountPending)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => (
        <InvoiceStatusBadge
          status={row.original.status}
          total={row.original.total}
          voided={!!row.original.voidedAt}
          awaitingPayment={row.original.issueOnPayment}
        />
      ),
    },
  ];

  const busy = bulkIssue.isPending || bulkCharge.isPending || bulkRemind.isPending;
  const sums = totals.data;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturas</h1>
          <p className="text-sm text-muted-foreground">
            Facturas emitidas y borradores. El número se pone al emitir.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/invoices/month-close">
              <CalendarCheck className="mr-1 h-4 w-4" /> Cierre del mes
            </Link>
          </Button>
          <Can permission="invoices:write">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Nueva factura
            </Button>
          </Can>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as InvoiceStatusValue))}
        >
          <SelectTrigger className="w-full sm:w-[190px]" aria-label="Estado">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {INVOICE_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CustomerSearchSelect
          value={customerId}
          onChange={setCustomerId}
          clearLabel="Todos los clientes"
          className="w-full sm:w-[240px]"
        />
        <Button
          variant="outline"
          className="w-full sm:hidden"
          onClick={() => setMoreFilters((v) => !v)}
        >
          {moreFilters ? 'Menos filtros' : 'Más filtros'}
          {secondaryActive > 0 && ` (${secondaryActive})`}
        </Button>
        <div className={moreFilters ? 'contents' : 'hidden sm:contents'}>
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
            <SelectTrigger className="w-full sm:w-[210px]" aria-label="Fecha de emisión">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {PERIOD_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={type ?? 'all'}
            onValueChange={(v) => setType(v === 'all' ? undefined : (v as InvoiceTypeFilterValue))}
          >
            <SelectTrigger className="w-full sm:w-[180px]" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {(Object.keys(TYPE_LABELS) as InvoiceTypeFilterValue[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {TYPE_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={payment ?? 'all'}
            onValueChange={(v) =>
              setPayment(v === 'all' ? undefined : (v as InvoicePaymentFilterValue))
            }
          >
            <SelectTrigger className="w-full sm:w-[240px]" aria-label="Forma de pago">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Cualquier forma de pago</SelectItem>
              {(Object.keys(PAYMENT_LABELS) as InvoicePaymentFilterValue[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {PAYMENT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as InvoiceSortValue)}>
            <SelectTrigger className="w-full sm:w-[220px]" aria-label="Orden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as InvoiceSortValue[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant={overdueOnly ? 'default' : 'outline'}
          onClick={() => setOverdueOnly((v) => !v)}
        >
          Solo vencidas
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Bookmark className="mr-1 h-4 w-4" /> Vistas
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Vistas del equipo</DropdownMenuLabel>
            {(views.data ?? []).length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Aún no hay ninguna. Pon unos filtros y guárdalos.
              </p>
            ) : (
              (views.data ?? []).map((v) => (
                <DropdownMenuItem key={v.id} onSelect={() => applyView(v)}>
                  <span className="flex-1 truncate">{v.name}</span>
                  <button
                    type="button"
                    aria-label={`Borrar la vista ${v.name}`}
                    className="ml-2 rounded p-0.5 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void onDeleteView(v);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!filtersActive} onSelect={() => void onSaveView()}>
              Guardar los filtros actuales…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" disabled={exporting} onClick={() => void exportCsv()}>
          {exporting ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-1 h-4 w-4" />
          )}
          CSV
        </Button>
        {selectable.length > 0 && !allSelected && (
          <Button
            variant="ghost"
            className="md:hidden"
            onClick={() => setSelectedIds(new Set(selectable))}
          >
            Seleccionar todas
          </Button>
        )}
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Emitidas desde</p>
            <DateSelect value={customFrom} onChange={setCustomFrom} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Hasta</p>
            <DateSelect value={customTo} onChange={setCustomTo} />
          </div>
        </div>
      )}

      {sums && (
        <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm sm:flex sm:flex-wrap sm:gap-x-6">
          <span>
            <span className="text-muted-foreground">Facturas </span>
            <span className="font-medium tabular-nums">{sums.count}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Total </span>
            <span className="font-medium tabular-nums">{formatEur(sums.total)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Cobrado </span>
            <span className="font-medium tabular-nums">{formatEur(sums.collected)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Pendiente </span>
            <span
              className={`font-medium tabular-nums ${sums.pending > 0 ? 'text-destructive' : ''}`}
            >
              {formatEur(sums.pending)}
            </span>
          </span>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">
            {selectedIds.size} {selectedIds.size === 1 ? 'seleccionada' : 'seleccionadas'}
          </span>
          <Can permission="invoices:manage">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedDraft.length === 0 || busy}
              onClick={onBulkIssue}
            >
              {bulkIssue.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Emitir {selectedDraft.length > 0 ? `(${selectedDraft.length})` : ''}
            </Button>
          </Can>
          <Can permission="payments:charge">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedChargeable.length === 0 || busy}
              onClick={onBulkCharge}
            >
              {bulkCharge.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Cobrar {selectedChargeable.length > 0 ? `(${selectedChargeable.length})` : ''}
            </Button>
          </Can>
          <Can permission="communications:send">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedChargeable.length === 0 || busy}
              onClick={onBulkRemind}
            >
              {bulkRemind.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Recordatorio {selectedChargeable.length > 0 ? `(${selectedChargeable.length})` : ''}
            </Button>
          </Can>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Quitar la selección
          </Button>
        </div>
      )}

      {invoices.isError ? (
        <SectionError onRetry={() => void invoices.refetch()} />
      ) : (
        <DataTable
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
          rowHref={(i) => `/invoices/${i.id}`}
          columns={columns}
          data={rows}
          isLoading={invoices.isLoading}
          serverSearch={{
            value: searchText,
            onChange: setSearchText,
            placeholder: 'Buscar por número o inquilino…',
          }}
          loadMore={invoices.loadMore}
          guide="cobrar"
          emptyText="Aún no hay facturas. Las de alquiler se crean solas cada mes; también puedes crear una con «Nueva factura»."
        />
      )}

      {createOpen && <NewInvoiceDialog onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
