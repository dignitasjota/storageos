'use client';

import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { parseAmount } from './fields';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
  useExpenseBudgets,
  useExpenseCategories,
  useRenameExpenseCategory,
  useSetExpenseBudgets,
} from '@/lib/expenses/hooks';

/** Categorías propias y presupuesto mensual por categoría. */
export function CategoriesTab({ canManage }: { canManage: boolean }) {
  const ask = useConfirm();
  const categories = useExpenseCategories();
  const budgets = useExpenseBudgets();
  const createCat = useCreateExpenseCategory();
  const renameCat = useRenameExpenseCategory();
  const deleteCat = useDeleteExpenseCategory();
  const setBudgets = useSetExpenseBudgets();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!budgets.data) return;
    setDraft(Object.fromEntries(budgets.data.map((b) => [b.category, String(b.monthlyAmount)])));
  }, [budgets.data]);

  async function add() {
    if (!newName.trim()) return;
    try {
      await createCat.mutateAsync({ name: newName.trim() });
      setNewName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    }
  }

  async function rename() {
    if (!renaming?.name.trim()) return;
    try {
      await renameCat.mutateAsync({ id: renaming.id, name: renaming.name.trim() });
      setRenaming(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar.');
    }
  }

  async function remove(id: string, name: string, usage: number) {
    if (
      !(await ask({
        title: `¿Borrar la categoría «${name}»?`,
        description:
          usage > 0 ? `Sus ${usage} gasto(s) pasan a «Otros».` : 'No la usa ningún gasto.',
        destructive: true,
      }))
    )
      return;
    try {
      await deleteCat.mutateAsync(id);
      toast.success('Categoría borrada.');
    } catch {
      toast.error('No se pudo borrar.');
    }
  }

  async function saveBudgets() {
    const list = Object.entries(draft)
      .map(([category, v]) => ({ category, monthlyAmount: parseAmount(v) ?? 0 }))
      .filter((b) => b.monthlyAmount > 0);
    try {
      await setBudgets.mutateAsync({ budgets: list });
      toast.success('Presupuesto guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const rows = categories.data ?? [];
  const totalBudget = Object.values(draft).reduce((s, v) => s + (parseAmount(v) ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Categorías y presupuesto</CardTitle>
        <p className="text-xs text-muted-foreground">
          Añade tus propias categorías y pon un presupuesto al mes: la cuenta de resultados lo
          compara con lo gastado.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-60"
              placeholder="Nueva categoría (p. ej. Limpieza)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
            <Button variant="outline" onClick={add} disabled={createCat.isPending}>
              <Plus className="mr-1 size-4" /> Añadir
            </Button>
          </div>
        )}
        {categories.isLoading ? (
          <div className="flex h-16 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : categories.isError ? (
          <SectionError onRetry={() => void categories.refetch()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Categoría</th>
                  <th className="p-2 text-right">Gastos</th>
                  <th className="p-2 text-right">Presupuesto al mes (€)</th>
                  {canManage && <th className="p-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const id = c.builtin ? null : c.key.slice('custom:'.length);
                  const isRenaming = !!id && renaming?.id === id;
                  return (
                    <tr key={c.key} className="border-t">
                      <td className="p-2">
                        {isRenaming ? (
                          <div className="flex items-center gap-1">
                            <Input
                              className="h-8 w-48"
                              value={renaming.name}
                              onChange={(e) => setRenaming({ id, name: e.target.value })}
                              onKeyDown={(e) => e.key === 'Enter' && void rename()}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              onClick={rename}
                              aria-label="Guardar"
                            >
                              <Check className="size-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              aria-label="Cancelar"
                              onClick={() => setRenaming(null)}
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            {c.name}
                            {!c.builtin && (
                              <Badge variant="outline" className="ml-2 text-[10px]">
                                Propia
                              </Badge>
                            )}
                          </>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums text-muted-foreground">
                        {c.usage}
                      </td>
                      <td className="p-2 text-right">
                        <Input
                          className="ml-auto h-8 w-28 text-right"
                          inputMode="decimal"
                          disabled={!canManage}
                          value={draft[c.key] ?? ''}
                          placeholder="—"
                          onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                        />
                      </td>
                      {canManage && (
                        <td className="p-2">
                          {id && !isRenaming && (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label="Cambiar el nombre"
                                onClick={() => setRenaming({ id, name: c.name })}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-red-600"
                                aria-label="Borrar"
                                onClick={() => remove(id, c.name, c.usage)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-medium">
                  <td className="p-2">Total al mes</td>
                  <td />
                  <td className="p-2 text-right tabular-nums">
                    {totalBudget.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                  </td>
                  {canManage && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {canManage && (
          <div className="flex justify-end">
            <Button onClick={saveBudgets} disabled={setBudgets.isPending}>
              {setBudgets.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Guardar el presupuesto
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
