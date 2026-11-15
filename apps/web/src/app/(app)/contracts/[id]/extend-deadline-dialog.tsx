'use client';

import { CalendarPlus } from 'lucide-react';
import { useState } from 'react';
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
import { ApiError } from '@/lib/auth/api';
import { useExtendPaymentDeadline } from '@/lib/customers/hooks';
import { formatDateTime } from '@/lib/format';

const OPTIONS = [
  { value: '1', label: '+1 día' },
  { value: '3', label: '+3 días' },
  { value: '7', label: '+7 días' },
  { value: 'date', label: 'Otra fecha' },
] as const;

/**
 * Ampliar el plazo para firmar y pagar: el trastero sigue reservado hasta la
 * fecha nueva y, si se quiere, el inquilino recibe un correo con el enlace.
 */
export function ExtendDeadlineButton({
  contractId,
  deadline,
  max,
  signed,
}: {
  contractId: string;
  /** Plazo actual (ISO). */
  deadline: string;
  /** Lo más lejos que se puede llevar (ISO). */
  max: string;
  signed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<(typeof OPTIONS)[number]['value']>('3');
  const [until, setUntil] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const extend = useExtendPaymentDeadline(contractId);

  const save = () =>
    extend.mutate(
      {
        ...(choice === 'date' ? { until: until! } : { days: Number(choice) }),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        notifyCustomer: notify,
      },
      {
        onSuccess: (r) => {
          toast.success(
            `Plazo ampliado hasta el ${formatDateTime(r.paymentDeadline)}${
              r.notified ? '. Le hemos avisado por correo.' : '.'
            }`,
          );
          setOpen(false);
          setReason('');
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido ampliar'),
      },
    );

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarPlus className="mr-1 size-4" /> Ampliar plazo
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Ampliar el plazo</DialogTitle>
            <DialogDescription>
              Ahora vence el {formatDateTime(deadline)}. Mientras dure, el trastero sigue reservado
              y la reserva no se cancela. Como mucho, hasta el {formatDateTime(max)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {OPTIONS.map((o) => (
                <Button
                  key={o.value}
                  type="button"
                  size="sm"
                  variant={choice === o.value ? 'default' : 'outline'}
                  onClick={() => setChoice(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
            {choice === 'date' && (
              <div className="space-y-1.5">
                <Label>Hasta el (incluido)</Label>
                <DateSelect future value={until} onChange={setUntil} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="deadline-reason">Motivo (opcional)</Label>
              <Input
                id="deadline-reason"
                maxLength={300}
                placeholder="Paga el lunes por transferencia"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={notify}
                onCheckedChange={(v) => setNotify(v === true)}
              />
              <span>
                Avisar al inquilino por correo
                <span className="block text-xs text-muted-foreground">
                  «Te guardamos el trastero hasta el…», con el enlace para{' '}
                  {signed ? 'pagar' : 'firmar y pagar'}.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={extend.isPending || (choice === 'date' && !until)}>
              Ampliar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
