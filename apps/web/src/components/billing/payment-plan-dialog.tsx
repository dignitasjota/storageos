'use client';

import { buildInstallments, type PaymentPlanFrequency } from '@storageos/shared';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCreatePaymentPlan } from '@/lib/collections-ops/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fracciona la deuda de un inquilino en cuotas. Mientras el plan esté activo y
 * al día, no se le reclaman esas facturas (ni recordatorios, ni recargo, ni
 * corte de acceso, ni reintentos de cobro).
 */
export function PaymentPlanDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  amount,
  invoiceIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  amount: number;
  invoiceIds?: string[];
}) {
  const create = useCreatePaymentPlan();
  const [count, setCount] = useState(3);
  const [firstDueDate, setFirstDueDate] = useState(inDays(7));
  const [frequency, setFrequency] = useState<PaymentPlanFrequency>('monthly');
  const [graceDays, setGraceDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const preview = useMemo(
    () =>
      amount > 0 && count >= 2 ? buildInstallments(amount, count, firstDueDate, frequency) : [],
    [amount, count, firstDueDate, frequency],
  );

  async function submit() {
    try {
      await create.mutateAsync({
        customerId,
        ...(invoiceIds?.length ? { invoiceIds } : {}),
        installmentsCount: count,
        firstDueDate,
        frequency,
        graceDays,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        notifyCustomer: notify,
      });
      toast.success('Plan de pago creado.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el plan.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Plan de pago — {customerName}</DialogTitle>
          <DialogDescription>
            Reparte {eur(amount)} en cuotas. Mientras vaya al día no se le reclaman estas facturas;
            si una cuota se retrasa más de los días de gracia, el plan se rompe y el escalado sigue.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="pp-count">Nº de cuotas</Label>
            <Input
              id="pp-count"
              type="number"
              min={2}
              max={24}
              value={count}
              onChange={(e) => setCount(Math.max(2, Math.min(24, Number(e.target.value) || 2)))}
            />
          </div>
          <div className="space-y-1">
            <Label>Frecuencia</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency(v as PaymentPlanFrequency)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Mensual</SelectItem>
                <SelectItem value="biweekly">Cada 15 días</SelectItem>
                <SelectItem value="weekly">Semanal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pp-first">Primera cuota</Label>
            <Input
              id="pp-first"
              type="date"
              value={firstDueDate}
              onChange={(e) => setFirstDueDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pp-grace">Días de gracia</Label>
            <Input
              id="pp-grace"
              type="number"
              min={0}
              max={30}
              value={graceDays}
              onChange={(e) => setGraceDays(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
            />
          </div>
        </div>
        {preview.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-auto rounded-md border p-2 text-sm">
            {preview.map((i, k) => (
              <li key={i.dueDate} className="flex justify-between">
                <span>
                  {k + 1}. {new Date(`${i.dueDate}T12:00:00`).toLocaleDateString('es-ES')}
                </span>
                <span className="tabular-nums">{eur(i.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1">
          <Label htmlFor="pp-notes">Nota interna (opcional)</Label>
          <Textarea
            id="pp-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
          Enviarle el calendario de cuotas por correo
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !firstDueDate}>
            Crear plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
