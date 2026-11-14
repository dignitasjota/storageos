'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useExpenseSuppliers } from '@/lib/expenses/hooks';

/**
 * Apuntar en Gastos lo que ha costado una tarea o una incidencia
 * (`path` = `/tasks/<id>/expense` o `/incidents/<id>/expense`).
 */
export function OpsExpenseDialog({
  path,
  title,
  defaultAmount,
  defaultSupplierId,
  onClose,
  onDone,
}: {
  path: string;
  title: string;
  defaultAmount?: number | null;
  defaultSupplierId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const suppliers = useExpenseSuppliers();
  const [amount, setAmount] = useState(defaultAmount ? String(defaultAmount) : '');
  const [supplierId, setSupplierId] = useState<string>(defaultSupplierId ?? 'none');
  const [saving, setSaving] = useState(false);

  async function save() {
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Indica el importe.');
      return;
    }
    setSaving(true);
    try {
      await apiFetch(path, {
        method: 'POST',
        json: { amount: value, ...(supplierId !== 'none' ? { supplierId } : {}) },
      });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      toast.success('Gasto apuntado.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo apuntar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Apuntar el gasto</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{title}</p>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ops-expense-amount">Importe (IVA incluido)</Label>
            <Input
              id="ops-expense-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Proveedor (opcional)</Label>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin proveedor</SelectItem>
                {(suppliers.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Se apunta en Gastos como mantenimiento, con fecha de hoy y en el local que toque.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Apuntar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
