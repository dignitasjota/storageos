'use client';

import { Loader2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto, WithdrawalBlockReason } from '@storageos/shared';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useContractWithdrawalPreview, useWithdrawContract } from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';

const BLOCKED: Record<WithdrawalBlockReason, string> = {
  not_applicable: 'Este contrato no lo firmó a distancia un particular.',
  deadline_passed:
    'En esa fecha ya habían pasado los 14 días: se da de baja con el preaviso del contrato.',
  not_signed: 'El contrato aún no está firmado.',
  pre_opening: 'Es una reserva antes de la apertura: se cancela como reserva.',
  closed: 'El contrato ya está cerrado.',
};

/** Días que se enseña el botón después del plazo (cartas enviadas a tiempo que llegan tarde). */
const LATE_REGISTRATION_DAYS = 30;

/**
 * Contrato firmado a distancia por un particular: hasta cuándo puede desistir,
 * si pidió empezar ya y, para el equipo, registrar un desistimiento recibido
 * por correo o por carta.
 */
export function WithdrawalCard({ contract }: { contract: ContractDto }) {
  const canManage = useHasPermission('contracts:manage');
  const [open, setOpen] = useState(false);
  const [communicatedOn, setCommunicatedOn] = useState('');
  const [note, setNote] = useState('');
  const preview = useContractWithdrawalPreview(contract.id, communicatedOn, open);
  const withdraw = useWithdrawContract(contract.id);
  const deadline = contract.withdrawalDeadline;
  if (!deadline) return null;

  const live = contract.status === 'active' || contract.status === 'ending';
  const lastDay = new Date(`${deadline}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() + LATE_REGISTRATION_DAYS);
  const canRegister =
    canManage &&
    live &&
    !contract.withdrawnAt &&
    localDateString() <= lastDay.toISOString().slice(0, 10);
  const p = preview.data;

  async function onConfirm() {
    try {
      await withdraw.mutateAsync({
        ...(communicatedOn ? { communicatedOn } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setOpen(false);
      toast.success(
        'Desistimiento registrado. El inquilino recibe un correo con lo que se le devuelve.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Undo2 className="size-4" />
          Desistimiento
        </CardTitle>
        <CardDescription>
          Lo firmó a distancia un particular: puede desistir en los 14 días naturales siguientes a
          la firma, sin dar explicaciones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {contract.withdrawnAt ? (
          <p>Desistió el {formatDateTime(contract.withdrawnAt)}: el contrato está cancelado.</p>
        ) : (
          <p>
            <span className="text-muted-foreground">Puede desistir hasta el </span>
            {formatDate(deadline)}
          </p>
        )}
        <p className="text-muted-foreground">
          {contract.immediateStartRequestedAt
            ? `Pidió empezar antes de que acabara el plazo (${formatDateTime(contract.immediateStartRequestedAt)})${contract.withdrawnAt ? ': se le descontaron los días que tuvo el trastero.' : ': si desiste, se le descuentan los días que haya tenido el trastero.'}`
            : contract.withdrawnAt
              ? 'No pidió empezar antes de que acabara el plazo: se le devolvió todo.'
              : 'No pidió empezar antes de que acabara el plazo: si desiste, se le devuelve todo.'}
        </p>
        {canRegister && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCommunicatedOn(localDateString());
              setNote('');
              setOpen(true);
            }}
          >
            Registrar desistimiento
          </Button>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar desistimiento</DialogTitle>
            <DialogDescription>
              Para un desistimiento que llega por correo o por carta. Cuenta el día en que lo
              comunicó, aunque lo registres más tarde.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Día en que lo comunicó</Label>
              <DateSelect
                value={communicatedOn}
                onChange={(v) => setCommunicatedOn(v ?? localDateString())}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="withdrawal-note">Cómo lo comunicó (opcional)</Label>
              <Input
                id="withdrawal-note"
                value={note}
                maxLength={500}
                placeholder="Correo del 12 de noviembre, carta certificada…"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {preview.isLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : preview.isError ? (
              <p className="text-sm text-destructive">
                {preview.error instanceof ApiError
                  ? preview.error.body.message
                  : 'No se pudo calcular.'}
              </p>
            ) : p && !p.allowed && p.reason ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                {BLOCKED[p.reason]}
              </p>
            ) : p ? (
              <ul className="space-y-1 rounded-md border p-3 text-sm">
                {p.rentPaid === 0 && p.depositRefund === 0 ? (
                  <li>No ha pagado nada: no hay nada que devolver.</li>
                ) : (
                  <>
                    <li>
                      Cuotas cobradas: {formatEur(p.rentPaid)} · se devuelven{' '}
                      <strong>{formatEur(p.rentRefund)}</strong>
                    </li>
                    {p.rentKept > 0 && (
                      <li className="text-muted-foreground">
                        Se quedan {formatEur(p.rentKept)} por {p.usedDays}{' '}
                        {p.usedDays === 1 ? 'día' : 'días'} de uso (pidió empezar ya).
                      </li>
                    )}
                    {p.depositRefund > 0 && (
                      <li>
                        Fianza: se devuelven <strong>{formatEur(p.depositRefund)}</strong>
                      </li>
                    )}
                  </>
                )}
                <li className="text-xs text-muted-foreground">
                  Lo cobrado con tarjeta o domiciliación se devuelve solo por la pasarela; lo demás
                  te queda como aviso para devolverlo a mano. Lo no cobrado se anula. El contrato se
                  cancela y el trastero queda libre.
                </li>
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              disabled={!p?.allowed || withdraw.isPending}
              onClick={() => void onConfirm()}
            >
              {withdraw.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Registrar y devolver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
