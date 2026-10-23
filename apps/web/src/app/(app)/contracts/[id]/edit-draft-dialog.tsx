'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto, UpdateContractInput } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateContract } from '@/lib/customers/hooks';

/**
 * Editar un contrato en borrador (antes de que lo firme el inquilino). Si el
 * inquilino tiene el enlace abierto, al firmar se le pedirá que vuelva a leerlo.
 */
export function EditDraftDialog({
  contract: c,
  open,
  onOpenChange,
}: {
  contract: ContractDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateContract();
  const initial = () => ({
    priceMonthly: String(c.priceMonthly),
    startDate: c.startDate.slice(0, 10),
    endDate: c.endDate?.slice(0, 10) ?? '',
    depositAmount: String(c.depositAmount),
    discountAmount: String(c.discountAmount),
    discountReason: c.discountReason ?? '',
    cancellationNoticeDays: String(c.cancellationNoticeDays),
    autoRenew: c.autoRenew,
    notes: c.notes ?? '',
  });
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c.id]);

  const set = <K extends keyof ReturnType<typeof initial>>(
    key: K,
    value: ReturnType<typeof initial>[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const price = Number(form.priceMonthly);
  const deposit = Number(form.depositAmount);
  const discount = Number(form.discountAmount);
  const notice = Number(form.cancellationNoticeDays);
  const valid =
    price > 0 &&
    deposit >= 0 &&
    discount >= 0 &&
    discount < price &&
    Number.isInteger(notice) &&
    notice >= 0 &&
    notice <= 365 &&
    !!form.startDate &&
    (!form.endDate || form.endDate >= form.startDate);

  async function save() {
    const input: UpdateContractInput = {
      ...(price !== c.priceMonthly ? { priceMonthly: price } : {}),
      ...(form.startDate !== c.startDate.slice(0, 10) ? { startDate: form.startDate } : {}),
      ...(form.endDate !== (c.endDate?.slice(0, 10) ?? '') ? { endDate: form.endDate } : {}),
      ...(deposit !== c.depositAmount ? { depositAmount: deposit } : {}),
      ...(discount !== c.discountAmount ? { discountAmount: discount } : {}),
      ...(form.discountReason !== (c.discountReason ?? '')
        ? { discountReason: form.discountReason }
        : {}),
      ...(notice !== c.cancellationNoticeDays ? { cancellationNoticeDays: notice } : {}),
      ...(form.autoRenew !== c.autoRenew ? { autoRenew: form.autoRenew } : {}),
      ...(form.notes !== (c.notes ?? '') ? { notes: form.notes } : {}),
    };
    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ id: c.id, input });
      toast.success('Borrador actualizado.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar borrador</DialogTitle>
          <DialogDescription>
            Solo antes de la firma. Lo que cambies aparece en el texto que firmará el inquilino.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="draft-price">Cuota mensual sin IVA (€)</Label>
            <Input
              id="draft-price"
              type="number"
              step="0.01"
              min={0}
              value={form.priceMonthly}
              disabled={!!c.coupon}
              onChange={(e) => set('priceMonthly', e.target.value)}
            />
            {c.coupon && (
              <p className="text-xs text-muted-foreground">
                Lleva el cupón {c.coupon.code}, calculado con esta cuota.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-deposit">Fianza (€)</Label>
            <Input
              id="draft-deposit"
              type="number"
              step="0.01"
              min={0}
              value={form.depositAmount}
              onChange={(e) => set('depositAmount', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-start">Fecha de inicio</Label>
            <Input
              id="draft-start"
              type="date"
              value={form.startDate}
              onChange={(e) => set('startDate', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-end">Fecha de fin (opcional)</Label>
            <Input
              id="draft-end"
              type="date"
              min={form.startDate}
              value={form.endDate}
              onChange={(e) => set('endDate', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-discount">Descuento al mes (€)</Label>
            <Input
              id="draft-discount"
              type="number"
              step="0.01"
              min={0}
              value={form.discountAmount}
              disabled={!!c.coupon}
              onChange={(e) => set('discountAmount', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-discount-reason">Motivo del descuento</Label>
            <Input
              id="draft-discount-reason"
              value={form.discountReason}
              onChange={(e) => set('discountReason', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-notice">Preaviso de baja (días)</Label>
            <Input
              id="draft-notice"
              type="number"
              min={0}
              max={365}
              value={form.cancellationNoticeDays}
              onChange={(e) => set('cancellationNoticeDays', e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Checkbox
              checked={form.autoRenew}
              onCheckedChange={(v) => set('autoRenew', v === true)}
            />
            Se renueva solo
          </label>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="draft-notes">Notas internas</Label>
            <Textarea
              id="draft-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!valid || update.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
