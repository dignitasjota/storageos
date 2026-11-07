'use client';

import {
  InvoiceStatusEnum,
  type BulkInvoiceActionResultDto,
  type CreatableInvoiceTypeValue,
  type InvoiceDto,
  type InvoiceStatusValue,
  type SimplifiedJustificationValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { INVOICE_STATUS_LABELS, InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useBulkChargeInvoices,
  useBulkIssueInvoices,
  useBulkRemindInvoices,
  useCreateInvoice,
} from '@/lib/billing/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';
import { useOpenFromUrl } from '@/lib/use-open-from-url';

const SIMPLIFIED_JUSTIFICATION_LABELS: Record<SimplifiedJustificationValue, string> = {
  reparation: 'Reparación',
  transport: 'Transporte',
  restaurant: 'Hostelería / restaurante',
  parking: 'Aparcamiento / autopista',
  other: 'Otros',
};

interface NewInvoiceDraftItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  /** Solo cuenta al 0 %: exenta o no sujeta (con tipo, siempre con IVA). */
  zeroCategory: ZeroRateCategory;
}

/** Tipos fiscales que se ofrecen para una línea al 0 %. */
type ZeroRateCategory = 'N1' | 'E1' | 'E6';
const ZERO_RATE_OPTIONS: { value: ZeroRateCategory; label: string }[] = [
  { value: 'N1', label: 'No sujeta (fianza, indemnización)' },
  { value: 'E1', label: 'Exenta art. 20 (p. ej. alquiler de vivienda)' },
  { value: 'E6', label: 'Exenta (otros)' },
];

const EMPTY_LINE: NewInvoiceDraftItem = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRate: 21,
  zeroCategory: 'N1',
};

function lineTotal(it: { quantity: number; unitPrice: number; taxRate: number }): number {
  const base = Math.round(it.quantity * it.unitPrice * 100);
  return (base + Math.round((base * it.taxRate) / 100)) / 100;
}

/** «Borrador» en vez del número provisional, que no significa nada. */
function invoiceLabel(i: InvoiceDto): string {
  return i.status === 'draft' ? 'Borrador' : i.invoiceNumber;
}

export default function InvoicesPage() {
  const router = useRouter();
  const ask = useConfirm();
  const [status, setStatus] = useState<InvoiceStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);
  // Enlaces con filtro (`/invoices?status=overdue` desde «Hoy» o las sugerencias).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    const parsed = InvoiceStatusEnum.safeParse(s);
    if (parsed.success) {
      setStatus(parsed.data);
    }
  }, []);

  // Estado del diálogo «Nueva factura»: completa (con cliente) o simplificada
  // (sin cliente, hasta 400 €; hasta 3.000 € con motivo).
  const [createOpen, setCreateOpen] = useState(false);
  useOpenFromUrl(() => setCreateOpen(true));
  const [newType, setNewType] = useState<CreatableInvoiceTypeValue>('F1');
  const [newCustomerId, setNewCustomerId] = useState<string>('');
  const [newJustification, setNewJustification] = useState<SimplifiedJustificationValue | ''>('');
  const [newItems, setNewItems] = useState<NewInvoiceDraftItem[]>([{ ...EMPTY_LINE }]);

  const headerFacilityId = useHeaderFacilityId();
  const [searchText, search, setSearchText] = useDebouncedSearch();
  const invoices = usePagedList<InvoiceDto>('invoices', '/invoices', {
    facilityId: headerFacilityId,
    status,
    customerId,
    overdue: overdueOnly ? 'true' : undefined,
    search: search || undefined,
  });
  const createInvoice = useCreateInvoice();
  const bulkIssue = useBulkIssueInvoices();
  const bulkCharge = useBulkChargeInvoices();
  const bulkRemind = useBulkRemindInvoices();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Al cambiar los filtros, lo seleccionado deja de verse: se suelta.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [status, customerId, overdueOnly, search, headerFacilityId]);

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
    const processing = res.processing?.length ?? 0;
    const ok = res.succeeded.length - processing;
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} ${done}`);
    if (processing > 0 && processingNote) parts.push(`${processing} ${processingNote}`);
    if (res.failed.length === 0) {
      toast.success(parts.join(' · ') || 'Hecho.');
      return;
    }
    const lines = res.failed
      .slice(0, 4)
      .map((f) => `${f.invoiceNumber ?? 'Borrador'}: ${f.message ?? 'no se ha podido'}`);
    if (res.failed.length > 4) lines.push(`y ${res.failed.length - 4} más`);
    toast.warning(`${parts.length ? `${parts.join(' · ')}. ` : ''}${res.failed.length} sin hacer`, {
      description: <div className="whitespace-pre-line">{lines.join('\n')}</div>,
      duration: 12_000,
    });
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
          'Les llega un correo con lo que deben y el enlace para pagar. A quien ya recibió uno hoy no se le envía otro.',
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

  const newTotal = newItems.reduce((acc, it) => acc + lineTotal(it), 0);
  const exceedsBasicF2 = newType === 'F2' && newTotal > 400;
  const linesInvalid = newItems.some(
    (it) => !it.description.trim() || !(it.quantity > 0) || !(it.unitPrice > 0),
  );

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
            aria-label={`Seleccionar ${invoiceLabel(i)} de ${i.customerName ?? 'cliente sin identificar'}`}
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
                i.status === 'draft'
                  ? 'text-xs italic text-muted-foreground hover:underline'
                  : 'font-mono text-xs hover:underline'
              }
            >
              {invoiceLabel(i)}
            </Link>
            {i.kind === 'deposit_receipt' && (
              <Badge variant="outline" title="Justificante de fianza: no es una factura">
                Fianza
              </Badge>
            )}
            {i.invoiceType === 'F2' && <Badge variant="outline">Simplificada</Badge>}
            {i.invoiceType.startsWith('R') && <Badge variant="outline">Rectificativa</Badge>}
            {i.lateFeeForInvoiceId && <Badge variant="outline">Recargo</Badge>}
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
      cell: ({ row }) =>
        row.original.status === 'draft' ? '—' : formatDate(row.original.issueDate),
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
        <InvoiceStatusBadge status={row.original.status} total={row.original.total} />
      ),
    },
  ];

  const busy = bulkIssue.isPending || bulkCharge.isPending || bulkRemind.isPending;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturas</h1>
          <p className="text-sm text-muted-foreground">
            Facturas emitidas y borradores. El número se pone al emitir.
          </p>
        </div>
        <Can permission="invoices:write">
          <Button
            onClick={() => {
              setNewType('F1');
              setNewCustomerId('');
              setNewJustification('');
              setNewItems([{ ...EMPTY_LINE }]);
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Nueva factura
          </Button>
        </Can>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as InvoiceStatusValue))}
        >
          <SelectTrigger className="w-full sm:w-[200px]">
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
          variant={overdueOnly ? 'default' : 'outline'}
          onClick={() => setOverdueOnly((v) => !v)}
        >
          Solo vencidas
        </Button>
        {selectable.length > 0 && (
          <Button
            variant="ghost"
            className="md:hidden"
            onClick={() => setSelectedIds(allSelected ? new Set() : new Set(selectable))}
          >
            {allSelected ? 'Quitar la selección' : 'Seleccionar todas'}
          </Button>
        )}
      </div>

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
          filtersActive={!!status || !!customerId || overdueOnly}
          onClearFilters={() => {
            setStatus(undefined);
            setCustomerId(undefined);
            setOverdueOnly(false);
          }}
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nueva factura</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>Tipo de factura</Label>
                <Select
                  value={newType}
                  onValueChange={(v) => setNewType(v as CreatableInvoiceTypeValue)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="F1">Completa (con los datos del cliente)</SelectItem>
                    <SelectItem value="F2">Simplificada (ticket, sin cliente)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {newType === 'F2'
                    ? 'Para ventas sueltas: hasta 400 €; hasta 3.000 € con un motivo.'
                    : 'Con el nombre y el NIF del cliente.'}
                </p>
              </div>
              {newType === 'F1' ? (
                <div className="space-y-1">
                  <Label>Cliente *</Label>
                  <CustomerSearchSelect
                    value={newCustomerId || undefined}
                    onChange={(id) => setNewCustomerId(id ?? '')}
                    placeholder="Busca el cliente…"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <Label>Motivo (si pasa de 400 €)</Label>
                  <Select
                    value={newJustification || 'none'}
                    onValueChange={(v) =>
                      setNewJustification(v === 'none' ? '' : (v as SimplifiedJustificationValue))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Ninguno" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Ninguno (hasta 400 €)</SelectItem>
                      {(
                        Object.keys(
                          SIMPLIFIED_JUSTIFICATION_LABELS,
                        ) as SimplifiedJustificationValue[]
                      ).map((k) => (
                        <SelectItem key={k} value={k}>
                          {SIMPLIFIED_JUSTIFICATION_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {newType === 'F2' && exceedsBasicF2 && !newJustification && (
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                El total ({formatEur(newTotal)}) pasa de 400 €: elige un motivo para llegar hasta
                3.000 €, o haz una factura completa.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Líneas</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setNewItems((curr) => [...curr, { ...EMPTY_LINE }])}
                >
                  <Plus className="mr-1 h-3 w-3" /> Añadir línea
                </Button>
              </div>
              <ul className="space-y-3">
                {newItems.map((it, idx) => (
                  <li key={idx} className="space-y-2 rounded border p-2">
                    <div className="flex gap-2">
                      <Input
                        aria-label="Concepto"
                        placeholder="Concepto"
                        value={it.description}
                        onChange={(e) =>
                          setNewItems((curr) =>
                            curr.map((row, i) =>
                              i === idx ? { ...row, description: e.target.value } : row,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Quitar línea"
                        disabled={newItems.length === 1}
                        onClick={() => setNewItems((curr) => curr.filter((_row, i) => i !== idx))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Cantidad</Label>
                        <Input
                          type="number"
                          step="1"
                          min="1"
                          inputMode="numeric"
                          value={it.quantity}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, quantity: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Precio sin IVA (€)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={it.unitPrice}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, unitPrice: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">IVA (%)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          inputMode="decimal"
                          value={it.taxRate}
                          onChange={(e) =>
                            setNewItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, taxRate: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                    {it.taxRate === 0 && (
                      <Select
                        value={it.zeroCategory}
                        onValueChange={(v) =>
                          setNewItems((curr) =>
                            curr.map((row, i) =>
                              i === idx ? { ...row, zeroCategory: v as ZeroRateCategory } : row,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="h-8 text-xs" aria-label="Tipo de operación">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ZERO_RATE_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {it.description.trim() && !(it.unitPrice > 0) && (
                      <p className="text-xs text-destructive">
                        El precio tiene que ser mayor que 0. Para restar, rectifica la factura.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-right text-sm tabular-nums">
                Total con IVA: <span className="font-semibold">{formatEur(newTotal)}</span>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                try {
                  const created = await createInvoice.mutateAsync({
                    invoiceType: newType,
                    ...(newType === 'F1' && newCustomerId ? { customerId: newCustomerId } : {}),
                    ...(newType === 'F2' && newJustification
                      ? { simplifiedJustification: newJustification }
                      : {}),
                    items: newItems.map((it) => ({
                      description: it.description,
                      quantity: it.quantity,
                      unitPrice: it.unitPrice,
                      taxRate: it.taxRate,
                      taxCategory: it.taxRate === 0 ? it.zeroCategory : 'S1',
                    })),
                    verifactuMode: 'verifactu',
                  });
                  toast.success('Factura creada como borrador.');
                  setCreateOpen(false);
                  router.push(`/invoices/${created.id}`);
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.body.message : 'No se ha podido crear.',
                  );
                }
              }}
              disabled={
                createInvoice.isPending ||
                (newType === 'F1' && !newCustomerId) ||
                linesInvalid ||
                (exceedsBasicF2 && !newJustification)
              }
            >
              {createInvoice.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Crear borrador
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
