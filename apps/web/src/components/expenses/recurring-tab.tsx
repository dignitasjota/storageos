'use client';

import {
  EXPENSE_FREQUENCY_LABELS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  type ExpenseFrequencyEnum,
  type ExpensePaymentMethod,
  type RecurringExpenseDto,
} from '@storageos/shared';
import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  AmountFields,
  CategorySelect,
  FacilitySelect,
  MarketingChannelField,
  NONE,
  PaymentMethodSelect,
  breakdownFrom,
  breakdownPayload,
  eur,
  type BreakdownState,
} from './fields';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect, MonthYearSelect } from '@/components/month-year-select';
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
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import {
  useCatchUpRecurringExpense,
  useCreateRecurringExpense,
  useDeleteRecurringExpense,
  useExpenseSuppliers,
  useRecurringExpenses,
  useRunRecurringExpenses,
  useUpdateRecurringExpense,
} from '@/lib/expenses/hooks';
import { formatDate } from '@/lib/format';

type Frequency = (typeof ExpenseFrequencyEnum.options)[number];
const PER: Record<Frequency, string> = { monthly: '/mes', quarterly: '/trimestre', yearly: '/año' };

export function RecurringTab({
  facilities,
  canManage,
}: {
  facilities: { id: string; name: string }[];
  canManage: boolean;
}) {
  const ask = useConfirm();
  const list = useRecurringExpenses();
  const run = useRunRecurringExpenses();
  const del = useDeleteRecurringExpense();
  const catchUp = useCatchUpRecurringExpense();
  const [editing, setEditing] = useState<RecurringExpenseDto | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = list.data ?? [];

  async function doRun() {
    try {
      const res = await run.mutateAsync();
      toast.success(
        res.created > 0
          ? `${res.created} gasto(s) generado(s).`
          : 'No había ningún gasto recurrente pendiente.',
      );
    } catch {
      toast.error('No se pudo generar.');
    }
  }
  async function remove(id: string) {
    if (
      !(await ask({
        title: '¿Eliminar este gasto recurrente?',
        description: 'Los gastos que ya generó se quedan.',
        destructive: true,
      }))
    )
      return;
    try {
      await del.mutateAsync(id);
      toast.success('Gasto recurrente eliminado.');
    } catch {
      toast.error('No se pudo eliminar.');
    }
  }
  async function doCatchUp(r: RecurringExpenseDto) {
    try {
      const res = await catchUp.mutateAsync(r.id);
      toast.success(`${res.created} gasto(s) generado(s).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Gastos recurrentes</CardTitle>
            <p className="text-xs text-muted-foreground">
              Se generan solos cada mes, trimestre o año (alquiler, suministros, seguros…). Con
              domiciliación o tarjeta nacen pagados; con transferencia o efectivo, pendientes de
              pagar.
            </p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={doRun} disabled={run.isPending}>
                <RefreshCw className="mr-1 size-4" /> Generar ahora
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="mr-1 size-4" /> Nuevo
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {list.isLoading ? (
          <div className="flex h-16 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : list.isError ? (
          <SectionError onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Sin gastos recurrentes. Crea el primero (p. ej. el alquiler del local).
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.id} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className={r.active ? '' : 'opacity-50'}>
                    <span className="font-medium">{r.description}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.categoryLabel} · {r.facilityName ?? 'General'} ·{' '}
                      {EXPENSE_FREQUENCY_LABELS[r.frequency].toLowerCase()}, día {r.dayOfMonth}
                      {r.supplierName || r.vendor ? ` · ${r.supplierName ?? r.vendor}` : ''}
                      {r.paymentMethod
                        ? ` · ${EXPENSE_PAYMENT_METHOD_LABELS[r.paymentMethod].toLowerCase()}`
                        : ''}
                      {!r.active && ' · pausado'}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {r.nextDate ? `Próximo: ${formatDate(r.nextDate)}` : 'Sin próximas fechas'}
                      {r.endDate ? ` · hasta el ${formatDate(r.endDate)}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">
                      {eur(r.totalAmount)}
                      {PER[r.frequency]}
                    </span>
                    {canManage && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Editar"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-red-600"
                          aria-label="Eliminar"
                          onClick={() => remove(r.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {r.missedDates.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    <AlertTriangle className="size-3.5" />
                    Sin generar: {r.missedDates.map((d) => formatDate(d)).join(', ')}
                    {canManage && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        disabled={catchUp.isPending}
                        onClick={() => doCatchUp(r)}
                      >
                        Generarlos ahora
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {(creating || editing) && (
        <RecurringDialog
          recurring={editing}
          facilities={facilities}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function RecurringDialog({
  recurring,
  facilities,
  onClose,
}: {
  recurring: RecurringExpenseDto | null;
  facilities: { id: string; name: string }[];
  onClose: () => void;
}) {
  const create = useCreateRecurringExpense();
  const update = useUpdateRecurringExpense();
  const suppliers = useExpenseSuppliers();
  const companyWide = useCompanyWide();
  const [facilityId, setFacilityId] = useState(
    recurring?.facilityId ?? (companyWide ? NONE : (facilities[0]?.id ?? NONE)),
  );
  const [category, setCategory] = useState(recurring?.category ?? 'rent');
  const [description, setDescription] = useState(recurring?.description ?? '');
  const [amounts, setAmounts] = useState<BreakdownState>(() =>
    breakdownFrom(recurring ? { ...recurring } : null),
  );
  const [frequency, setFrequency] = useState<Frequency>(recurring?.frequency ?? 'monthly');
  const [dayOfMonth, setDayOfMonth] = useState(String(recurring?.dayOfMonth ?? 1));
  const [startMonth, setStartMonth] = useState(
    (recurring?.startDate ?? localDateString()).slice(0, 7),
  );
  const [endDate, setEndDate] = useState(recurring?.endDate ?? '');
  const [supplierId, setSupplierId] = useState(recurring?.supplierId ?? NONE);
  const [method, setMethod] = useState<ExpensePaymentMethod | null>(
    recurring?.paymentMethod ?? null,
  );
  const [active, setActive] = useState(recurring?.active ?? true);
  const [marketingChannelId, setMarketingChannelId] = useState(
    recurring?.marketingChannelId ?? NONE,
  );
  const busy = create.isPending || update.isPending;

  function onSupplier(value: string) {
    setSupplierId(value);
    const s = (suppliers.data ?? []).find((x) => x.id === value);
    if (!s) return;
    if (s.defaultCategory) setCategory(s.defaultCategory);
    if (s.defaultPaymentMethod) setMethod(s.defaultPaymentMethod);
    setAmounts((a) => ({
      ...a,
      broken: true,
      ...(s.defaultVatRate !== null ? { vatRate: String(s.defaultVatRate) } : {}),
      ...(s.defaultWithholdingRate !== null
        ? { withholdingRate: String(s.defaultWithholdingRate) }
        : {}),
      ...(s.defaultWithholdingModel ? { withholdingModel: s.defaultWithholdingModel } : {}),
    }));
  }

  async function save() {
    const supplier = (suppliers.data ?? []).find((s) => s.id === supplierId);
    const payload = {
      facilityId: facilityId === NONE ? null : facilityId,
      category,
      description: description.trim(),
      ...breakdownPayload(amounts),
      marketingChannelId:
        category === 'marketing' && marketingChannelId !== NONE ? marketingChannelId : null,
      dayOfMonth: Math.min(28, Math.max(1, Number(dayOfMonth) || 1)),
      frequency,
      startDate: `${startMonth}-01`,
      endDate: endDate || null,
      supplierId: supplier?.id ?? null,
      vendor: supplier?.name ?? '',
      vendorTaxId: supplier?.taxId ?? '',
      paymentMethod: method,
      active,
    };
    const amountOk = amounts.broken
      ? ((payload as { baseAmount?: number | null }).baseAmount ?? 0) > 0
      : ((payload as { amount?: number }).amount ?? 0) > 0;
    if (!payload.description || !amountOk) {
      toast.error('Indica un concepto y un importe.');
      return;
    }
    try {
      const saved = recurring
        ? await update.mutateAsync({ id: recurring.id, input: payload })
        : await create.mutateAsync(payload);
      toast.success(
        saved.missedDates.length > 0
          ? `Guardado. Hay ${saved.missedDates.length} fecha(s) anterior(es) sin generar: puedes generarlas desde la lista.`
          : 'Gasto recurrente guardado.',
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {recurring ? 'Editar gasto recurrente' : 'Nuevo gasto recurrente'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Concepto</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Cada cuánto</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['monthly', 'quarterly', 'yearly'] as const).map((f) => (
                    <SelectItem key={f} value={f}>
                      {EXPENSE_FREQUENCY_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Día del mes (1-28)</Label>
              <Input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Empieza en</Label>
              <MonthYearSelect value={startMonth} onChange={setStartMonth} around />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Categoría</Label>
              <CategorySelect value={category} onChange={setCategory} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Local</Label>
              <FacilitySelect value={facilityId} onChange={setFacilityId} facilities={facilities} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Proveedor</Label>
              <Select value={supplierId} onValueChange={onSupplier}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin proveedor</SelectItem>
                  {(suppliers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Forma de pago</Label>
              <PaymentMethodSelect value={method} onChange={setMethod} allowNone />
            </div>
          </div>
          {category === 'marketing' && (
            <MarketingChannelField value={marketingChannelId} onChange={setMarketingChannelId} />
          )}
          <AmountFields value={amounts} onChange={setAmounts} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Termina (opcional)</Label>
              <DateSelect value={endDate} onChange={(v) => setEndDate(v ?? '')} future />
            </div>
            <label className="flex items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Activo
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
