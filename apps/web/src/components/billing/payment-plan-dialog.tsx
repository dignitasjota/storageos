'use client';

import { buildInstallments, type PaymentPlanFrequency } from '@storageos/shared';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { DateSelect } from '@/components/month-year-select';
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
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';

const eur = formatEur;

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
  // Se teclea libre (10, 12…) y se comprueba al crear.
  const [countText, setCountText] = useState('3');
  const count = Number(countText);
  const countOk = Number.isInteger(count) && count >= 2 && count <= 24;
  const [firstDueDate, setFirstDueDate] = useState(inDays(7));
  const [frequency, setFrequency] = useState<PaymentPlanFrequency>('monthly');
  const [graceText, setGraceText] = useState('7');
  const graceDays = Number(graceText);
  const graceOk = Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 30;
  const today = localDateString();
  const dateOk = !!firstDueDate && firstDueDate >= today;
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const preview = useMemo(
    () =>
      amount > 0 && countOk && firstDueDate
        ? buildInstallments(amount, count, firstDueDate, frequency)
        : [],
    [amount, count, countOk, firstDueDate, frequency],
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
              inputMode="numeric"
              value={countText}
              onChange={(e) => setCountText(e.target.value.replace(/\D/g, '').slice(0, 2))}
            />
            {!countOk && <p className="text-xs text-destructive">Entre 2 y 24 cuotas.</p>}
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
            <Label>Primera cuota</Label>
            <DateSelect
              future
              value={firstDueDate}
              onChange={(v) => setFirstDueDate(v ?? inDays(7))}
            />
            {!dateOk && (
              <p className="text-xs text-destructive">No puede ser un día que ya ha pasado.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pp-grace">Días de gracia</Label>
            <Input
              id="pp-grace"
              inputMode="numeric"
              value={graceText}
              onChange={(e) => setGraceText(e.target.value.replace(/\D/g, '').slice(0, 2))}
            />
            {!graceOk && <p className="text-xs text-destructive">Entre 0 y 30 días.</p>}
          </div>
        </div>
        {preview.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-auto rounded-md border p-2 text-sm">
            {preview.map((i, k) => (
              <li key={i.dueDate} className="flex justify-between">
                <span>
                  {k + 1}. {formatDate(i.dueDate)}
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
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !countOk || !graceOk || !dateOk}
          >
            Crear plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
