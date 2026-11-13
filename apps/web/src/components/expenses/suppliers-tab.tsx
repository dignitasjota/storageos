'use client';

import {
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_VAT_RATE_OPTIONS,
  EXPENSE_WITHHOLDING_MODEL_LABELS,
  EXPENSE_WITHHOLDING_RATE_OPTIONS,
  type ExpensePaymentMethod,
  type ExpenseSupplierDto,
  type ExpenseWithholdingModel,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { CategorySelect, NONE, PaymentMethodSelect, eur } from './fields';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateExpenseSupplier,
  useDeleteExpenseSupplier,
  useExpenseSuppliers,
  useUpdateExpenseSupplier,
} from '@/lib/expenses/hooks';

export function SuppliersTab({
  canManage,
  onShowExpenses,
}: {
  canManage: boolean;
  /** Abre la lista de gastos filtrada por el proveedor. */
  onShowExpenses: (supplierId: string) => void;
}) {
  const ask = useConfirm();
  const [showInactive, setShowInactive] = useState(false);
  const list = useExpenseSuppliers(showInactive);
  const del = useDeleteExpenseSupplier();
  const [editing, setEditing] = useState<ExpenseSupplierDto | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = list.data ?? [];

  async function remove(s: ExpenseSupplierDto) {
    if (
      !(await ask({
        title: `¿Borrar a ${s.name}?`,
        description: 'Sus gastos se quedan con su nombre y su NIF.',
        destructive: true,
      }))
    )
      return;
    try {
      await del.mutateAsync(s.id);
      toast.success('Proveedor borrado.');
    } catch {
      toast.error('No se pudo borrar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Proveedores</CardTitle>
            <p className="text-xs text-muted-foreground">
              Con su categoría, IVA, retención y forma de pago: al elegirlos en un gasto se rellena
              solo.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Ver los desactivados
            </label>
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="mr-1 size-4" /> Nuevo proveedor
              </Button>
            )}
          </div>
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
            Sin proveedores. Crea los habituales (el propietario del local, la eléctrica, la
            gestoría…).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Proveedor</th>
                  <th className="p-2">Por defecto</th>
                  <th className="p-2 text-right">Gastos</th>
                  <th className="p-2 text-right">Últimos 12 meses</th>
                  {canManage && <th className="p-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="p-2">
                      <span className="font-medium">{s.name}</span>
                      {!s.isActive && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          Desactivado
                        </Badge>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {[s.taxId, s.email, s.phone].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {[
                        s.defaultCategoryLabel,
                        s.defaultVatRate !== null ? `IVA ${s.defaultVatRate} %` : null,
                        s.defaultWithholdingRate
                          ? `retención ${s.defaultWithholdingRate} % (${s.defaultWithholdingModel})`
                          : null,
                        s.defaultPaymentMethod
                          ? EXPENSE_PAYMENT_METHOD_LABELS[s.defaultPaymentMethod].toLowerCase()
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="p-2 text-right">
                      {s.expenseCount > 0 ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() => onShowExpenses(s.id)}
                        >
                          {s.expenseCount}
                        </Button>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">{eur(s.last12Months)}</td>
                    {canManage && (
                      <td className="p-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Editar"
                            onClick={() => setEditing(s)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-red-600"
                            aria-label="Borrar"
                            onClick={() => remove(s)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {(creating || editing) && (
        <SupplierDialog
          supplier={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function SupplierDialog({
  supplier,
  onClose,
}: {
  supplier: ExpenseSupplierDto | null;
  onClose: () => void;
}) {
  const create = useCreateExpenseSupplier();
  const update = useUpdateExpenseSupplier();
  const [name, setName] = useState(supplier?.name ?? '');
  const [taxId, setTaxId] = useState(supplier?.taxId ?? '');
  const [email, setEmail] = useState(supplier?.email ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [category, setCategory] = useState(supplier?.defaultCategory ?? NONE);
  const [vatRate, setVatRate] = useState(
    supplier?.defaultVatRate !== null && supplier?.defaultVatRate !== undefined
      ? String(supplier.defaultVatRate)
      : NONE,
  );
  const [withholdingRate, setWithholdingRate] = useState(
    String(supplier?.defaultWithholdingRate ?? 0),
  );
  const [withholdingModel, setWithholdingModel] = useState<ExpenseWithholdingModel>(
    supplier?.defaultWithholdingModel ?? '111',
  );
  const [method, setMethod] = useState<ExpensePaymentMethod | null>(
    supplier?.defaultPaymentMethod ?? null,
  );
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [active, setActive] = useState(supplier?.isActive ?? true);
  const busy = create.isPending || update.isPending;

  async function save() {
    if (!name.trim()) {
      toast.error('Escribe el nombre del proveedor.');
      return;
    }
    const wh = Number(withholdingRate) || 0;
    const input = {
      name: name.trim(),
      taxId: taxId.trim(),
      email: email.trim(),
      phone: phone.trim(),
      defaultCategory: category === NONE ? null : category,
      defaultVatRate: vatRate === NONE ? null : Number(vatRate),
      defaultWithholdingRate: wh > 0 ? wh : null,
      defaultWithholdingModel: wh > 0 ? withholdingModel : null,
      defaultPaymentMethod: method,
      notes: notes.trim(),
      isActive: active,
    };
    try {
      if (supplier) await update.mutateAsync({ id: supplier.id, input });
      else await create.mutateAsync(input);
      toast.success('Proveedor guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{supplier ? 'Editar proveedor' : 'Nuevo proveedor'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Nombre o razón social</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">NIF</Label>
              <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Teléfono</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <p className="text-xs font-medium text-muted-foreground">Al elegirlo en un gasto</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Categoría</Label>
              <CategorySelect value={category} onChange={setCategory} allowNone />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">IVA</Label>
              <Select value={vatRate} onValueChange={setVatRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin indicar</SelectItem>
                  {EXPENSE_VAT_RATE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r} %
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Retención IRPF</Label>
              <Select value={withholdingRate} onValueChange={setWithholdingRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_WITHHOLDING_RATE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r === 0 ? 'Sin retención' : `${r} %`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(Number(withholdingRate) || 0) > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Se declara en</Label>
                <Select
                  value={withholdingModel}
                  onValueChange={(v) => setWithholdingModel(v as ExpenseWithholdingModel)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['111', '115'] as const).map((m) => (
                      <SelectItem key={m} value={m}>
                        {EXPENSE_WITHHOLDING_MODEL_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Forma de pago</Label>
              <PaymentMethodSelect value={method} onChange={setMethod} allowNone />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Notas</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {supplier && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Activo (sale al elegir proveedor)
            </label>
          )}
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
