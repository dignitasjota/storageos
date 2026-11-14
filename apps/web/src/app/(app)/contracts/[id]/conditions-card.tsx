'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto, UpdateContractInput } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateContract } from '@/lib/customers/hooks';
import { formatDate } from '@/lib/format';

/** Lo que se puede cambiar de un contrato ya firmado sin tocar lo económico. */
export function ConditionsCard({ contract: c }: { contract: ContractDto }) {
  const [open, setOpen] = useState(false);
  const live = c.status === 'active' || c.status === 'ending';
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">Condiciones</CardTitle>
        {live && (
          <Can permission="contracts:write">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Editar
            </Button>
          </Can>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[180px_1fr]">
          <dt className="text-muted-foreground">Fecha de fin</dt>
          <dd>{c.endDate ? formatDate(c.endDate) : 'Sin fecha (indefinido)'}</dd>
          <dt className="text-muted-foreground">Renovación automática</dt>
          <dd>{c.autoRenew ? 'Sí, por el mismo plazo' : 'No'}</dd>
          <dt className="text-muted-foreground">Preaviso de baja</dt>
          <dd>{c.cancellationNoticeDays} días</dd>
          {c.specificConditions && (
            <>
              <dt className="text-muted-foreground">Condiciones específicas</dt>
              <dd className="whitespace-pre-line">{c.specificConditions}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Notas</dt>
          <dd className="whitespace-pre-line">{c.notes || '—'}</dd>
        </dl>
      </CardContent>
      {open && <ConditionsDialog contract={c} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function ConditionsDialog({
  contract: c,
  onClose,
}: {
  contract: ContractDto;
  onClose: () => void;
}) {
  const update = useUpdateContract();
  const [endDate, setEndDate] = useState(c.endDate?.slice(0, 10) ?? '');
  const [autoRenew, setAutoRenew] = useState(c.autoRenew);
  const [notice, setNotice] = useState(String(c.cancellationNoticeDays));
  const [notes, setNotes] = useState(c.notes ?? '');
  const noticeDays = Number(notice);
  const valid =
    Number.isInteger(noticeDays) &&
    noticeDays >= 0 &&
    noticeDays <= 365 &&
    (c.status !== 'ending' || !!endDate) &&
    (!endDate || endDate >= c.startDate.slice(0, 10));

  async function save() {
    const input: UpdateContractInput = {
      ...(endDate !== (c.endDate?.slice(0, 10) ?? '') ? { endDate } : {}),
      ...(autoRenew !== c.autoRenew ? { autoRenew } : {}),
      ...(noticeDays !== c.cancellationNoticeDays ? { cancellationNoticeDays: noticeDays } : {}),
      ...(notes !== (c.notes ?? '') ? { notes } : {}),
    };
    if (Object.keys(input).length === 0) return onClose();
    try {
      await update.mutateAsync({ id: c.id, input });
      toast.success('Condiciones guardadas.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Condiciones del contrato</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cond-end">Fecha de fin</Label>
            <Input
              id="cond-end"
              type="date"
              min={c.startDate.slice(0, 10)}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {c.status === 'ending'
                ? 'Es el último día de la baja: el contrato se cierra después de esta fecha.'
                : 'Vacío: contrato indefinido.'}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoRenew} onCheckedChange={(v) => setAutoRenew(v === true)} />
            Renovar solo al llegar a la fecha de fin, por el mismo plazo
          </label>
          <div className="space-y-1">
            <Label htmlFor="cond-notice">Preaviso de baja (días)</Label>
            <Input
              id="cond-notice"
              type="number"
              min={0}
              max={365}
              value={notice}
              onChange={(e) => setNotice(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cond-notes">Notas</Label>
            <Textarea
              id="cond-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
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
