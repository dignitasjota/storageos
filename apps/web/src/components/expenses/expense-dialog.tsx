'use client';

import {
  EXPENSE_PAYMENT_STATUS_LABELS,
  type ExpenseDto,
  type ExpensePaymentMethod,
  type ExpensePaymentStatus,
  type ExpenseSupplierDto,
} from '@storageos/shared';
import { FileText, Loader2, Paperclip, Sparkles, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
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
  type BreakdownState,
} from './fields';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasFeature } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import {
  fetchExpenseReceiptUrl,
  uploadExpenseReceipt,
  useCreateExpense,
  useCreateExpenseSupplier,
  useExpenseSuppliers,
  useReadExpenseReceipt,
  useUpdateExpense,
} from '@/lib/expenses/hooks';
import { compressImage } from '@/lib/images/compress';

const NEW_SUPPLIER = '__new__';
const RECEIPT_TYPES = 'application/pdf,image/png,image/jpeg';

interface ReceiptState {
  key: string | null;
  name: string | null;
  mime: string | null;
  /** Ya guardado en el gasto (se ve con su URL firmada). */
  saved: boolean;
}

/**
 * Alta y edición de un gasto. `template` duplica otro (sin el justificante,
 * con fecha de hoy).
 */
export function ExpenseDialog({
  expense,
  template,
  facilities,
  onClose,
}: {
  expense?: ExpenseDto | null;
  template?: ExpenseDto | null;
  facilities: { id: string; name: string }[];
  onClose: () => void;
}) {
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const createSupplier = useCreateExpenseSupplier();
  const suppliers = useExpenseSuppliers();
  const readReceipt = useReadExpenseReceipt();
  const aiEnabled = useHasFeature('ai_assistant');
  const companyWide = useCompanyWide();
  const source = expense ?? template ?? null;
  const today = localDateString();

  const [facilityId, setFacilityId] = useState(
    source?.facilityId ?? (companyWide ? NONE : (facilities[0]?.id ?? NONE)),
  );
  const [category, setCategory] = useState(source?.category ?? 'other');
  const [description, setDescription] = useState(source?.description ?? '');
  const [expenseDate, setExpenseDate] = useState(expense?.expenseDate ?? today);
  const [supplierId, setSupplierId] = useState(source?.supplierId ?? NONE);
  const [vendor, setVendor] = useState(source?.vendor ?? '');
  const [vendorTaxId, setVendorTaxId] = useState(source?.vendorTaxId ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(expense?.invoiceNumber ?? '');
  const [notes, setNotes] = useState(source?.source === 'recurring' ? '' : (source?.notes ?? ''));
  const [marketingChannelId, setMarketingChannelId] = useState(source?.marketingChannelId ?? NONE);
  const [amounts, setAmounts] = useState<BreakdownState>(() => breakdownFrom(source));
  const [status, setStatus] = useState<ExpensePaymentStatus>(expense?.paymentStatus ?? 'paid');
  const [paidAt, setPaidAt] = useState(expense?.paidAt ?? today);
  const [method, setMethod] = useState<ExpensePaymentMethod | null>(source?.paymentMethod ?? null);
  const [dueDate, setDueDate] = useState(expense?.dueDate ?? '');
  const [receipt, setReceipt] = useState<ReceiptState>({
    key: null,
    name: expense?.hasReceipt ? (expense.receiptName ?? 'Justificante') : null,
    mime: null,
    saved: !!expense?.hasReceipt,
  });
  const [receiptChanged, setReceiptChanged] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newSupplier, setNewSupplier] = useState({ name: '', taxId: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = create.isPending || update.isPending || uploading;

  const supplierList: ExpenseSupplierDto[] = suppliers.data ?? [];

  function applySupplier(s: ExpenseSupplierDto) {
    setVendor(s.name);
    setVendorTaxId(s.taxId ?? '');
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

  function onSupplier(value: string) {
    setSupplierId(value);
    const s = supplierList.find((x) => x.id === value);
    if (s) applySupplier(s);
  }

  async function addSupplier() {
    if (!newSupplier.name.trim()) {
      toast.error('Escribe el nombre del proveedor.');
      return;
    }
    try {
      const s = await createSupplier.mutateAsync({
        name: newSupplier.name.trim(),
        taxId: newSupplier.taxId.trim(),
        ...(category ? { defaultCategory: category } : {}),
      });
      setSupplierId(s.id);
      applySupplier(s);
      setNewSupplier({ name: '', taxId: '' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el proveedor.');
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!RECEIPT_TYPES.split(',').includes(file.type)) {
      toast.error('El justificante tiene que ser un PDF, JPG o PNG.');
      return;
    }
    setUploading(true);
    try {
      const prepared = file.type.startsWith('image/') ? await compressImage(file) : file;
      if (prepared.size > 10 * 1024 * 1024) {
        toast.error('El justificante supera los 10 MB.');
        return;
      }
      const key = await uploadExpenseReceipt(prepared);
      setReceipt({ key, name: prepared.name, mime: prepared.type, saved: false });
      setReceiptChanged(true);
    } catch {
      toast.error('No se ha podido subir el justificante.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function readWithAi() {
    if (!receipt.key) return;
    try {
      const r = await readReceipt.mutateAsync(receipt.key);
      if (r.vendor) setVendor(r.vendor);
      if (r.vendorTaxId) setVendorTaxId(r.vendorTaxId);
      if (r.invoiceNumber) setInvoiceNumber(r.invoiceNumber);
      if (r.expenseDate) setExpenseDate(r.expenseDate);
      if (r.description && !description.trim()) setDescription(r.description);
      if (r.category) setCategory(r.category);
      if (r.supplierId) setSupplierId(r.supplierId);
      if (r.baseAmount !== null) {
        setAmounts((a) => ({
          ...a,
          broken: true,
          baseAmount: String(r.baseAmount),
          ...(r.vatRate !== null ? { vatRate: String(r.vatRate) } : {}),
          withholdingRate: String(r.withholdingRate ?? 0),
        }));
      } else if (r.totalAmount !== null) {
        setAmounts((a) => ({ ...a, broken: false, amount: String(r.totalAmount) }));
      }
      toast.success('Datos leídos. Revísalos antes de guardar.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido leer.');
    }
  }

  async function openSavedReceipt() {
    if (!expense) return;
    try {
      const { url } = await fetchExpenseReceiptUrl(expense.id);
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.error('No se ha podido abrir el justificante.');
    }
  }

  const payload = useMemo(() => {
    const base = {
      facilityId: facilityId === NONE ? null : facilityId,
      category,
      description: description.trim(),
      expenseDate,
      vendor: vendor.trim(),
      vendorTaxId: vendorTaxId.trim(),
      invoiceNumber: invoiceNumber.trim(),
      supplierId: supplierId === NONE || supplierId === NEW_SUPPLIER ? null : supplierId,
      notes: notes.trim(),
      marketingChannelId:
        category === 'marketing' && marketingChannelId !== NONE ? marketingChannelId : null,
      ...breakdownPayload(amounts),
      paymentStatus: status,
      paymentMethod: method,
      ...(status === 'paid' ? { paidAt } : { dueDate: dueDate || null }),
    };
    if (!receiptChanged) return base;
    return {
      ...base,
      receiptKey: receipt.key,
      receiptName: receipt.key ? receipt.name : null,
      receiptMime: receipt.key
        ? (receipt.mime as 'application/pdf' | 'image/png' | 'image/jpeg')
        : null,
    };
  }, [
    facilityId,
    category,
    description,
    expenseDate,
    vendor,
    vendorTaxId,
    invoiceNumber,
    supplierId,
    notes,
    marketingChannelId,
    amounts,
    status,
    paidAt,
    method,
    dueDate,
    receipt,
    receiptChanged,
  ]);

  async function save() {
    const amountOk = amounts.broken
      ? (payload as { baseAmount?: number | null }).baseAmount! > 0
      : ((payload as { amount?: number }).amount ?? 0) > 0;
    if (!payload.description || !amountOk) {
      toast.error('Indica un concepto y un importe.');
      return;
    }
    try {
      const saved = expense
        ? await update.mutateAsync({ id: expense.id, input: payload })
        : await create.mutateAsync(payload);
      if (saved.cashNotice) toast.warning(saved.cashNotice);
      else toast.success('Gasto guardado.');
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
            {expense ? 'Editar gasto' : template ? 'Duplicar gasto' : 'Nuevo gasto'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Justificante */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
            <Paperclip className="size-4 text-muted-foreground" />
            {receipt.name ? (
              <>
                <span className="max-w-[16rem] truncate text-sm">{receipt.name}</span>
                {receipt.saved && !receiptChanged && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={openSavedReceipt}
                  >
                    Ver
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Quitar el justificante"
                  onClick={() => {
                    setReceipt({ key: null, name: null, mime: null, saved: false });
                    setReceiptChanged(true);
                  }}
                >
                  <X className="size-4" />
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                Sin justificante (foto o PDF de la factura).
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <FileText className="mr-1 size-4" />
                )}
                {receipt.name ? 'Cambiar' : 'Adjuntar'}
              </Button>
              {receipt.key && !receipt.saved && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!aiEnabled || readReceipt.isPending}
                  title={
                    aiEnabled
                      ? 'Gasta una consulta del asistente IA de este mes'
                      : 'Necesita el asistente IA en tu plan'
                  }
                  onClick={readWithAi}
                >
                  {readReceipt.isPending ? (
                    <Loader2 className="mr-1 size-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 size-4" />
                  )}
                  Leer con IA
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={RECEIPT_TYPES}
              capture="environment"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Concepto</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Fecha de la factura</Label>
              <DateSelect value={expenseDate} onChange={(v) => v && setExpenseDate(v)} around />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Categoría</Label>
              <CategorySelect value={category} onChange={setCategory} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Local</Label>
              <FacilitySelect value={facilityId} onChange={setFacilityId} facilities={facilities} />
            </div>
            {category === 'marketing' && (
              <div className="sm:col-span-2">
                <MarketingChannelField
                  value={marketingChannelId}
                  onChange={setMarketingChannelId}
                />
              </div>
            )}
          </div>

          {/* Proveedor */}
          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-xs">Proveedor</Label>
            <Select value={supplierId} onValueChange={onSupplier}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin ficha de proveedor</SelectItem>
                {supplierList.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.taxId ? ` · ${s.taxId}` : ''}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_SUPPLIER}>+ Nuevo proveedor</SelectItem>
              </SelectContent>
            </Select>
            {supplierId === NEW_SUPPLIER && (
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  className="min-w-0 flex-1"
                  placeholder="Nombre o razón social"
                  value={newSupplier.name}
                  onChange={(e) => setNewSupplier((s) => ({ ...s, name: e.target.value }))}
                />
                <Input
                  className="w-36"
                  placeholder="NIF"
                  value={newSupplier.taxId}
                  onChange={(e) => setNewSupplier((s) => ({ ...s, taxId: e.target.value }))}
                />
                <Button size="sm" onClick={addSupplier} disabled={createSupplier.isPending}>
                  Crear
                </Button>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                placeholder="Nombre en la factura"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
              <Input
                placeholder="NIF"
                value={vendorTaxId}
                onChange={(e) => setVendorTaxId(e.target.value)}
              />
              <Input
                placeholder="Nº de factura"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>
          </div>

          <AmountFields value={amounts} onChange={setAmounts} />

          {/* Pago */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Pago</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ExpensePaymentStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['paid', 'pending'] as const).map((s) => (
                      <SelectItem key={s} value={s}>
                        {EXPENSE_PAYMENT_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Forma de pago</Label>
                <PaymentMethodSelect value={method} onChange={setMethod} allowNone />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">{status === 'paid' ? 'Pagado el' : 'Vence el'}</Label>
                {status === 'paid' ? (
                  <DateSelect value={paidAt} onChange={(v) => v && setPaidAt(v)} around />
                ) : (
                  <DateSelect value={dueDate} onChange={(v) => setDueDate(v ?? '')} around />
                )}
              </div>
            </div>
            {status === 'paid' && method === 'cash' && (
              <p className="text-xs text-muted-foreground">
                Se apunta como salida en la caja de ese día
                {facilityId === NONE ? ' (la de toda la empresa)' : ' del local'}.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Notas (opcional)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
