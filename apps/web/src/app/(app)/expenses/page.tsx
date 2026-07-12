'use client';

import {
  EXPENSE_CATEGORY_LABELS,
  ExpenseCategoryEnum,
  type ExpenseCategory,
  type ExpenseDto,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenses,
  useProfitLoss,
  useUpdateExpense,
} from '@/lib/expenses/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const CATEGORIES = ExpenseCategoryEnum.options;
const ALL = '__all__';
const NONE = '__none__';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

export default function ExpensesPage() {
  const canManage = useHasPermission('expenses:manage');
  const facilities = useFacilities();
  const [range, setRange] = useState(monthRange);
  const [facilityFilter, setFacilityFilter] = useState<string>(ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [editing, setEditing] = useState<ExpenseDto | null>(null);
  const [creating, setCreating] = useState(false);

  const pnl = useProfitLoss(range.from, range.to);
  const expenses = useExpenses({
    ...(facilityFilter !== ALL ? { facilityId: facilityFilter } : {}),
    ...(categoryFilter !== ALL ? { category: categoryFilter } : {}),
    from: range.from,
    to: range.to,
  });
  const del = useDeleteExpense();

  const facilityOptions = facilities.data ?? [];

  async function remove(id: string) {
    if (!window.confirm('¿Eliminar este gasto?')) return;
    try {
      await del.mutateAsync(id);
      toast.success('Gasto eliminado.');
    } catch {
      toast.error('No se pudo eliminar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Gastos y rentabilidad</h1>
          <p className="text-sm text-muted-foreground">
            Registra los gastos del negocio y ve la cuenta de resultados por local.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" /> Nuevo gasto
          </Button>
        )}
      </div>

      {/* Periodo */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs">Desde</Label>
          <Input
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </div>
        <div>
          <Label className="text-xs">Hasta</Label>
          <Input
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </div>
      </div>

      {/* Cuenta de resultados */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cuenta de resultados por local</CardTitle>
        </CardHeader>
        <CardContent>
          {pnl.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Local</th>
                    <th className="p-2 text-right">Facturado</th>
                    <th className="p-2 text-right">Cobrado</th>
                    <th className="p-2 text-right">Gastos</th>
                    <th className="p-2 text-right">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {(pnl.data?.rows ?? []).map((r) => (
                    <tr key={r.facilityId ?? 'none'} className="border-t">
                      <td className="p-2">{r.facilityName}</td>
                      <td className="p-2 text-right tabular-nums">{eur(r.invoiced)}</td>
                      <td className="p-2 text-right tabular-nums text-muted-foreground">
                        {eur(r.collected)}
                      </td>
                      <td className="p-2 text-right tabular-nums text-muted-foreground">
                        {eur(r.expenses)}
                      </td>
                      <td
                        className={`p-2 text-right font-semibold tabular-nums ${
                          r.net >= 0 ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      >
                        {eur(r.net)}
                      </td>
                    </tr>
                  ))}
                  {(pnl.data?.rows ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-muted-foreground">
                        Sin movimientos en este periodo.
                      </td>
                    </tr>
                  )}
                </tbody>
                {pnl.data && pnl.data.rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="p-2">Total</td>
                      <td className="p-2 text-right tabular-nums">
                        {eur(pnl.data.totals.invoiced)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {eur(pnl.data.totals.collected)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {eur(pnl.data.totals.expenses)}
                      </td>
                      <td
                        className={`p-2 text-right tabular-nums ${
                          pnl.data.totals.net >= 0 ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      >
                        {eur(pnl.data.totals.net)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
              {pnl.data && pnl.data.byCategory.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {pnl.data.byCategory.map((c) => (
                    <span key={c.category} className="rounded-md border px-2 py-1">
                      {EXPENSE_CATEGORY_LABELS[c.category]}: {eur(c.amount)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lista de gastos */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Gastos</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Select value={facilityFilter} onValueChange={setFacilityFilter}>
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
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas las categorías</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {EXPENSE_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {expenses.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (expenses.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin gastos en este periodo.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Fecha</th>
                    <th className="p-2">Categoría</th>
                    <th className="p-2">Local</th>
                    <th className="p-2">Concepto</th>
                    <th className="p-2 text-right">Importe</th>
                    {canManage && <th className="p-2" />}
                  </tr>
                </thead>
                <tbody>
                  {(expenses.data ?? []).map((e) => (
                    <tr key={e.id} className="border-t">
                      <td className="p-2 tabular-nums">{e.expenseDate}</td>
                      <td className="p-2">{EXPENSE_CATEGORY_LABELS[e.category]}</td>
                      <td className="p-2 text-muted-foreground">{e.facilityName ?? '— General'}</td>
                      <td className="p-2">
                        {e.description}
                        {e.vendor && (
                          <span className="ml-1 text-xs text-muted-foreground">· {e.vendor}</span>
                        )}
                      </td>
                      <td className="p-2 text-right font-medium tabular-nums">{eur(e.amount)}</td>
                      {canManage && (
                        <td className="p-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label="Editar"
                              onClick={() => setEditing(e)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-red-600"
                              aria-label="Eliminar"
                              onClick={() => remove(e.id)}
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
      </Card>

      {(creating || editing) && (
        <ExpenseDialog
          expense={editing}
          facilities={facilityOptions}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ExpenseDialog({
  expense,
  facilities,
  onClose,
}: {
  expense: ExpenseDto | null;
  facilities: { id: string; name: string }[];
  onClose: () => void;
}) {
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const [facilityId, setFacilityId] = useState(expense?.facilityId ?? NONE);
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? 'other');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState(String(expense?.amount ?? ''));
  const [expenseDate, setExpenseDate] = useState(
    expense?.expenseDate ?? new Date().toISOString().slice(0, 10),
  );
  const [vendor, setVendor] = useState(expense?.vendor ?? '');
  const busy = create.isPending || update.isPending;

  const payload = useMemo(
    () => ({
      facilityId: facilityId === NONE ? null : facilityId,
      category,
      description: description.trim(),
      amount: Number(amount) || 0,
      expenseDate,
      vendor: vendor.trim(),
    }),
    [facilityId, category, description, amount, expenseDate, vendor],
  );

  async function save() {
    if (!payload.description || payload.amount <= 0) {
      toast.error('Indica un concepto y un importe.');
      return;
    }
    try {
      if (expense) await update.mutateAsync({ id: expense.id, input: payload });
      else await create.mutateAsync(payload);
      toast.success('Gasto guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? 'Editar gasto' : 'Nuevo gasto'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Fecha</Label>
              <Input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Importe (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Categoría</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {EXPENSE_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Local</Label>
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>General (sin local)</SelectItem>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Concepto</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Proveedor (opcional)</Label>
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
