'use client';

import {
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_SOURCE_LABELS,
  type ExpenseDto,
  type ExpensePaymentMethod,
} from '@storageos/shared';
import {
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { CategoriesTab } from '@/components/expenses/categories-tab';
import { ExpenseDialog } from '@/components/expenses/expense-dialog';
import {
  ALL,
  CategorySelect,
  FacilitySelect,
  NONE,
  PaymentMethodSelect,
  eur,
} from '@/components/expenses/fields';
import { PnlTab } from '@/components/expenses/pnl-tab';
import { RecurringTab } from '@/components/expenses/recurring-tab';
import { SuppliersTab } from '@/components/expenses/suppliers-tab';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { localDateString, localMonthStart } from '@/lib/dates';
import {
  fetchExpenseReceiptUrl,
  fetchExpensesExport,
  useBulkExpenses,
  useDeleteExpense,
  useExpenseSuppliers,
  useExpensesTotal,
  useMarkExpensePaid,
  useMarkExpensePending,
} from '@/lib/expenses/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate } from '@/lib/format';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';

/** El mes en curso entero: un gasto con fecha posterior a hoy de este mes también sale. */
function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = localMonthStart(0, now);
  const to = localDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  return { from, to };
}

type PayTarget = { ids: string[]; label: string } | null;

export default function ExpensesPage() {
  const ask = useConfirm();
  const canManage = useHasPermission('expenses:manage');
  const facilities = useFacilities();
  const facilityOptions = facilities.data ?? [];
  const suppliers = useExpenseSuppliers(true);
  const [tab, setTab] = useState('list');
  const [range, setRange] = useState(monthRange);
  const [facilityFilterId, setFacilityFilterId] = useFacilityFilterState();
  const facilityFilter = facilityFilterId ?? ALL;
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const params = useSearchParams();
  // «Hoy» abre la lista con los pendientes de pago.
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const status = params.get('status');
    return status === 'pending' || status === 'overdue' || status === 'paid' ? status : ALL;
  });
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null);
  const [searchInput, search, setSearch] = useDebouncedSearch();
  const [dialog, setDialog] = useState<
    { mode: 'create' } | { mode: 'edit' | 'duplicate'; expense: ExpenseDto } | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payTarget, setPayTarget] = useState<PayTarget>(null);
  const [exporting, setExporting] = useState(false);

  const filters = {
    facilityId: facilityFilter !== ALL ? facilityFilter : undefined,
    category: categoryFilter !== ALL ? categoryFilter : undefined,
    paymentStatus: statusFilter !== ALL ? statusFilter : undefined,
    supplierId: supplierFilter ?? undefined,
    from: range.from,
    to: range.to,
    search: search || undefined,
  };
  const expenses = usePagedList<ExpenseDto>('expenses', '/expenses', filters);
  const total = useExpensesTotal(filters);
  const del = useDeleteExpense();
  const markPending = useMarkExpensePending();
  const bulk = useBulkExpenses();

  const editable = (e: ExpenseDto) => e.source !== 'google_ads' && e.source !== 'meta_ads';
  const selectable = expenses.rows.filter(editable);
  const allSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function remove(e: ExpenseDto) {
    if (
      !(await ask({
        title: '¿Eliminar este gasto?',
        description: e.cashMovementId ? 'También se quita su salida de la caja.' : undefined,
        destructive: true,
      }))
    )
      return;
    try {
      await del.mutateAsync(e.id);
      toast.success('Gasto eliminado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo eliminar.');
    }
  }

  async function undoPay(e: ExpenseDto) {
    try {
      await markPending.mutateAsync(e.id);
      toast.success('Vuelve a estar pendiente de pago.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar.');
    }
  }

  async function openReceipt(e: ExpenseDto) {
    try {
      const { url } = await fetchExpenseReceiptUrl(e.id);
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.error('No se ha podido abrir el justificante.');
    }
  }

  function reportBulk(res: { succeeded: number; failed: { error: string }[] }, done: string) {
    if (res.failed.length === 0) toast.success(`${res.succeeded} ${done}.`);
    else
      toast.warning(`${res.succeeded} ${done}; ${res.failed.length} no: ${res.failed[0]!.error}`);
    setSelected(new Set());
  }

  async function bulkCategory(category: string) {
    try {
      reportBulk(
        await bulk.mutateAsync({ action: 'category', ids: [...selected], category }),
        'cambiados',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar.');
    }
  }

  async function bulkFacility(facilityId: string) {
    try {
      reportBulk(
        await bulk.mutateAsync({
          action: 'facility',
          ids: [...selected],
          facilityId: facilityId === NONE ? null : facilityId,
        }),
        'cambiados',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar.');
    }
  }

  async function bulkDelete() {
    if (!(await ask({ title: `¿Eliminar ${selected.size} gastos?`, destructive: true }))) return;
    try {
      reportBulk(await bulk.mutateAsync({ action: 'delete', ids: [...selected] }), 'eliminados');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo eliminar.');
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = await fetchExpensesExport(filters);
      downloadCsv(`gastos-${range.from}_${range.to}.csv`, [
        [
          'Fecha',
          'Concepto',
          'Categoría',
          'Local',
          'Proveedor',
          'NIF',
          'Nº factura',
          'Base',
          'IVA %',
          'IVA',
          'IVA deducible',
          'Retención %',
          'Retención',
          'Modelo',
          'Coste',
          'A pagar',
          'Pago',
          'Pagado el',
          'Forma de pago',
          'Vence el',
          'Notas',
        ],
        ...rows.map((e) => [
          formatDate(e.expenseDate),
          e.description,
          e.categoryLabel,
          e.facilityName ?? 'General',
          e.vendor ?? '',
          e.vendorTaxId ?? '',
          e.invoiceNumber ?? '',
          e.baseAmount ?? '',
          e.vatRate ?? '',
          e.vatAmount ?? '',
          e.broken ? (e.vatDeductible ? 'Sí' : 'No') : '',
          e.withholdingRate ?? '',
          e.withholdingAmount ?? '',
          e.withholdingModel ?? '',
          e.amount,
          e.totalAmount,
          e.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente',
          e.paidAt ? formatDate(e.paidAt) : '',
          e.paymentMethod ? EXPENSE_PAYMENT_METHOD_LABELS[e.paymentMethod] : '',
          e.dueDate ? formatDate(e.dueDate) : '',
          e.notes ?? '',
        ]),
      ]);
      if (rows.length >= 5000) toast.warning('El CSV lleva los 5.000 primeros: acota el periodo.');
    } catch {
      toast.error('No se ha podido descargar.');
    } finally {
      setExporting(false);
    }
  }

  const concept = (e: ExpenseDto) => (
    <>
      <span>{e.description}</span>
      {e.hasReceipt && (
        <button
          type="button"
          className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
          aria-label="Ver el justificante"
          title="Ver el justificante"
          onClick={() => void openReceipt(e)}
        >
          <Paperclip className="size-3.5" />
        </button>
      )}
      {e.source !== 'manual' && (
        <Badge variant="outline" className="ml-2 text-[10px]">
          {EXPENSE_SOURCE_LABELS[e.source]}
        </Badge>
      )}
      {(e.vendor || e.invoiceNumber) && (
        <span className="block text-xs text-muted-foreground">
          {[e.vendor, e.vendorTaxId, e.invoiceNumber && `fra. ${e.invoiceNumber}`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {e.notes && e.source !== 'recurring' && (
        <span className="block text-xs text-muted-foreground">{e.notes}</span>
      )}
    </>
  );
  const payment = (e: ExpenseDto) =>
    e.paymentStatus === 'paid' ? (
      <span className="text-muted-foreground">
        Pagado
        {e.paymentMethod && ` · ${EXPENSE_PAYMENT_METHOD_LABELS[e.paymentMethod].toLowerCase()}`}
      </span>
    ) : (
      <Badge
        variant="outline"
        className={
          e.overdue
            ? 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400'
            : 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300'
        }
      >
        {e.overdue ? 'Vencido' : 'Pendiente'}
        {e.dueDate && ` · ${formatDate(e.dueDate)}`}
      </Badge>
    );
  const amount = (e: ExpenseDto) => (
    <>
      <span className="font-medium tabular-nums">{eur(e.amount)}</span>
      {e.broken && e.totalAmount !== e.amount && (
        <span className="block text-xs text-muted-foreground tabular-nums">
          a pagar {eur(e.totalAmount)}
        </span>
      )}
      {!e.broken && <span className="block text-[10px] text-muted-foreground">sin desglosar</span>}
    </>
  );
  const actions = (e: ExpenseDto) =>
    !editable(e) ? (
      <span
        className="block text-right text-xs text-muted-foreground"
        title="Se actualiza solo con la sincronización del canal de marketing"
      >
        Automático
      </span>
    ) : (
      <div className="flex justify-end gap-1">
        {e.paymentStatus === 'pending' ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Marcar pagado"
            title="Marcar pagado"
            onClick={() => setPayTarget({ ids: [e.id], label: e.description })}
          >
            <CheckCircle2 className="size-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Volver a pendiente"
            title="Volver a pendiente"
            onClick={() => void undoPay(e)}
          >
            <Undo2 className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Editar"
          title="Editar"
          onClick={() => setDialog({ mode: 'edit', expense: e })}
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Duplicar"
          title="Duplicar"
          onClick={() => setDialog({ mode: 'duplicate', expense: e })}
        >
          <Copy className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-red-600"
          aria-label="Eliminar"
          title="Eliminar"
          onClick={() => void remove(e)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    );

  const supplierName = supplierFilter
    ? ((suppliers.data ?? []).find((s) => s.id === supplierFilter)?.name ?? 'Proveedor')
    : null;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Gastos y rentabilidad</h1>
          <p className="text-sm text-muted-foreground">
            Registra los gastos con su factura, controla lo que queda por pagar y ve la cuenta de
            resultados por local.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/expenses/import">
                <Upload className="mr-1 size-4" /> Importar
              </Link>
            </Button>
            <Button onClick={() => setDialog({ mode: 'create' })}>
              <Plus className="mr-1 size-4" /> Nuevo gasto
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Desde</Label>
          <DateSelect
            value={range.from}
            onChange={(v) => v && setRange((r) => ({ ...r, from: v }))}
            around
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Hasta</Label>
          <DateSelect
            value={range.to}
            onChange={(v) => v && setRange((r) => ({ ...r, to: v }))}
            around
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="list">Gastos</TabsTrigger>
          <TabsTrigger value="pnl">Cuenta de resultados</TabsTrigger>
          <TabsTrigger value="recurring">Recurrentes</TabsTrigger>
          <TabsTrigger value="suppliers">Proveedores</TabsTrigger>
          <TabsTrigger value="categories">Categorías y presupuesto</TabsTrigger>
        </TabsList>

        <TabsContent value="list">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Gastos</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
                    <Input
                      value={searchInput}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Concepto, proveedor, NIF o factura"
                      className="h-8 w-56 pl-8 text-xs"
                    />
                  </div>
                  <Select
                    value={facilityFilter}
                    onValueChange={(v) => setFacilityFilterId(v === ALL ? undefined : v)}
                  >
                    <SelectTrigger className="h-8 w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>Todos los locales</SelectItem>
                      {facilityOptions.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <CategorySelect
                    value={categoryFilter}
                    onChange={setCategoryFilter}
                    includeAll
                    className="h-8 w-40 text-xs"
                  />
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="h-8 w-48 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>Pagados y pendientes</SelectItem>
                      <SelectItem value="pending">Pendientes de pago</SelectItem>
                      <SelectItem value="overdue">Vencidos</SelectItem>
                      <SelectItem value="paid">Pagados</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={exportCsv}
                    disabled={exporting}
                  >
                    {exporting ? (
                      <Loader2 className="mr-1 size-4 animate-spin" />
                    ) : (
                      <Download className="mr-1 size-4" />
                    )}
                    CSV
                  </Button>
                </div>
              </div>
              {supplierName && (
                <div>
                  <Badge variant="secondary" className="gap-1">
                    Proveedor: {supplierName}
                    <button
                      type="button"
                      aria-label="Quitar el filtro de proveedor"
                      onClick={() => setSupplierFilter(null)}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {total.data && total.data.count > 0 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {total.data.count} {total.data.count === 1 ? 'gasto' : 'gastos'} ·{' '}
                  <span className="font-medium text-foreground">{eur(total.data.amount)}</span>
                  {total.data.pending > 0 && (
                    <>
                      {' '}
                      · por pagar{' '}
                      <span className="font-medium text-foreground">{eur(total.data.pending)}</span>
                    </>
                  )}
                </p>
              )}
              {canManage && selected.size > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
                  <span className="font-medium">{selected.size} seleccionados</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() =>
                      setPayTarget({ ids: [...selected], label: `${selected.size} gastos` })
                    }
                  >
                    <CheckCircle2 className="mr-1 size-3.5" /> Marcar pagados
                  </Button>
                  <CategorySelect
                    value=""
                    onChange={(v) => void bulkCategory(v)}
                    className="h-7 w-40 text-xs"
                    placeholder="Cambiar categoría"
                  />
                  <FacilitySelect
                    value=""
                    onChange={(v) => void bulkFacility(v)}
                    facilities={facilityOptions}
                    className="h-7 w-40 text-xs"
                    placeholder="Cambiar local"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-red-700 dark:text-red-400"
                    onClick={bulkDelete}
                  >
                    <Trash2 className="mr-1 size-3.5" /> Eliminar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => setSelected(new Set())}
                  >
                    Quitar la selección
                  </Button>
                </div>
              )}
              {expenses.isLoading ? (
                <div className="flex h-24 items-center justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : expenses.isError ? (
                <SectionError onRetry={() => void expenses.refetch()} />
              ) : expenses.rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {search
                    ? 'Ningún gasto coincide con la búsqueda.'
                    : 'Sin gastos en este periodo.'}
                </p>
              ) : (
                <>
                  {/* En el móvil, tarjetas. */}
                  <ul className="divide-y sm:hidden">
                    {expenses.rows.map((e) => (
                      <li key={e.id} className="flex gap-2 py-3 text-sm">
                        {canManage && editable(e) && (
                          <input
                            type="checkbox"
                            aria-label="Seleccionar"
                            className="mt-1"
                            checked={selected.has(e.id)}
                            onChange={() => toggle(e.id)}
                          />
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex justify-between gap-2">
                            <div className="min-w-0">{concept(e)}</div>
                            <div className="shrink-0 text-right">{amount(e)}</div>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span>
                              {formatDate(e.expenseDate)} · {e.categoryLabel} ·{' '}
                              {e.facilityName ?? 'General'}
                            </span>
                            <span className="text-xs">{payment(e)}</span>
                          </div>
                          {canManage && <div>{actions(e)}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                          {canManage && (
                            <th className="w-8 p-2">
                              <input
                                type="checkbox"
                                aria-label="Seleccionar todos"
                                checked={allSelected}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? new Set(selectable.map((x) => x.id))
                                      : new Set(),
                                  )
                                }
                              />
                            </th>
                          )}
                          <th className="p-2">Fecha</th>
                          <th className="p-2">Concepto</th>
                          <th className="p-2">Categoría · local</th>
                          <th className="p-2">Pago</th>
                          <th className="p-2 text-right">Importe</th>
                          {canManage && <th className="p-2" />}
                        </tr>
                      </thead>
                      <tbody>
                        {expenses.rows.map((e) => (
                          <tr key={e.id} className="border-t align-top">
                            {canManage && (
                              <td className="p-2">
                                {editable(e) && (
                                  <input
                                    type="checkbox"
                                    aria-label="Seleccionar"
                                    checked={selected.has(e.id)}
                                    onChange={() => toggle(e.id)}
                                  />
                                )}
                              </td>
                            )}
                            <td className="whitespace-nowrap p-2 tabular-nums">
                              {formatDate(e.expenseDate)}
                            </td>
                            <td className="p-2">{concept(e)}</td>
                            <td className="p-2 text-xs text-muted-foreground">
                              {e.categoryLabel}
                              <span className="block">{e.facilityName ?? 'General'}</span>
                            </td>
                            <td className="p-2 text-xs">{payment(e)}</td>
                            <td className="p-2 text-right">{amount(e)}</td>
                            {canManage && <td className="p-2">{actions(e)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {expenses.loadMore.hasMore && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={expenses.loadMore.loading}
                    onClick={expenses.loadMore.onLoadMore}
                  >
                    {expenses.loadMore.loading ? 'Cargando…' : 'Cargar más'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pnl">
          <PnlTab from={range.from} to={range.to} />
        </TabsContent>

        <TabsContent value="recurring">
          <RecurringTab facilities={facilityOptions} canManage={canManage} />
        </TabsContent>

        <TabsContent value="suppliers">
          <SuppliersTab
            canManage={canManage}
            onShowExpenses={(id) => {
              setSupplierFilter(id);
              setTab('list');
            }}
          />
        </TabsContent>

        <TabsContent value="categories">
          <CategoriesTab canManage={canManage} />
        </TabsContent>
      </Tabs>

      {dialog && (
        <ExpenseDialog
          expense={dialog.mode === 'edit' ? dialog.expense : null}
          template={dialog.mode === 'duplicate' ? dialog.expense : null}
          facilities={facilityOptions}
          onClose={() => setDialog(null)}
        />
      )}
      {payTarget && (
        <PayDialog
          target={payTarget}
          onClose={(cleared) => {
            setPayTarget(null);
            if (cleared) setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

/** Marcar pagado (uno o varios): fecha y forma de pago. */
function PayDialog({
  target,
  onClose,
}: {
  target: NonNullable<PayTarget>;
  onClose: (cleared: boolean) => void;
}) {
  const markPaid = useMarkExpensePaid();
  const bulk = useBulkExpenses();
  const [paidAt, setPaidAt] = useState(localDateString());
  const [method, setMethod] = useState<ExpensePaymentMethod | null>('bank_transfer');
  const busy = markPaid.isPending || bulk.isPending;

  async function save() {
    if (!method) {
      toast.error('Elige la forma de pago.');
      return;
    }
    try {
      if (target.ids.length === 1) {
        const saved = await markPaid.mutateAsync({
          id: target.ids[0]!,
          input: { paidAt, paymentMethod: method },
        });
        if (saved.cashNotice) toast.warning(saved.cashNotice);
        else toast.success('Gasto pagado.');
      } else {
        const res = await bulk.mutateAsync({
          action: 'mark_paid',
          ids: target.ids,
          paidAt,
          paymentMethod: method,
        });
        if (res.failed.length === 0) toast.success(`${res.succeeded} gastos pagados.`);
        else
          toast.warning(
            `${res.succeeded} pagados; ${res.failed.length} no: ${res.failed[0]!.error}`,
          );
      }
      onClose(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo marcar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar pagado · {target.label}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Pagado el</Label>
            <DateSelect value={paidAt} onChange={(v) => v && setPaidAt(v)} around />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Forma de pago</Label>
            <PaymentMethodSelect value={method} onChange={setMethod} />
          </div>
        </div>
        {method === 'cash' && (
          <p className="text-xs text-muted-foreground">
            Se apunta como salida en la caja de ese día.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            Marcar pagado
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
