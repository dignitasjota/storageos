'use client';

import { UNIT_STATUS_TRANSITIONS, type UnitStatusValue } from '@storageos/shared';
import { useEffect, useState } from 'react';
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
import { ApiError } from '@/lib/auth/api';
import { useChangeUnitStatus } from '@/lib/facilities/hooks';

export const UNIT_STATUS_LABELS: Record<UnitStatusValue, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

/**
 * Cambio de estado de un trastero: solo ofrece los cambios posibles desde el
 * estado actual y, al pasarlo a mantenimiento, pide cuándo vuelve y si crea una
 * tarea.
 */
export function ChangeUnitStatusDialog({
  unit,
  onClose,
}: {
  unit: { id: string; code: string; status: UnitStatusValue } | null;
  onClose: () => void;
}) {
  const change = useChangeUnitStatus();
  const options = unit ? UNIT_STATUS_TRANSITIONS[unit.status] : [];
  const [status, setStatus] = useState<UnitStatusValue>('available');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState<string | undefined>();
  const [createTask, setCreateTask] = useState(true);

  useEffect(() => {
    if (!unit) return;
    setStatus(UNIT_STATUS_TRANSITIONS[unit.status][0] ?? 'available');
    setReason('');
    setUntil(undefined);
    setCreateTask(true);
  }, [unit]);

  async function submit() {
    if (!unit) return;
    try {
      await change.mutateAsync({
        id: unit.id,
        input: {
          status,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(status === 'maintenance' && until ? { until } : {}),
          ...(status === 'maintenance' ? { createTask } : {}),
        },
      });
      toast.success(
        status === 'maintenance' && createTask
          ? 'En mantenimiento: se ha creado la tarea.'
          : 'Estado actualizado.',
      );
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string }).code : undefined;
      toast.error(
        code === 'occupied_via_contract_only'
          ? 'El estado «ocupado» se asigna al firmar un contrato.'
          : err instanceof ApiError
            ? err.body.message
            : 'No se pudo cambiar.',
      );
    }
  }

  return (
    <Dialog open={!!unit} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambiar estado del trastero {unit?.code}</DialogTitle>
          <DialogDescription>
            Estado actual: {unit ? UNIT_STATUS_LABELS[unit.status] : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nuevo estado</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as UnitStatusValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {UNIT_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="status-reason">
              {status === 'maintenance' ? 'Qué hay que hacer' : 'Motivo (opcional)'}
            </Label>
            <Input id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {status === 'maintenance' && (
            <>
              <div className="space-y-2">
                <Label>Vuelve a estar disponible (previsto)</Label>
                <DateSelect years={2} future value={until} onChange={setUntil} />
                <p className="text-xs text-muted-foreground">
                  Si pasa la fecha o lleva más de 7 días parado, sale en «Hoy».
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={createTask} onCheckedChange={(v) => setCreateTask(v === true)} />
                Crear una tarea de mantenimiento
              </label>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={change.isPending || options.length === 0}>
            {change.isPending ? 'Guardando…' : 'Cambiar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
