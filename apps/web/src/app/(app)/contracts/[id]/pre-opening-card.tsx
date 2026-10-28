'use client';

import { Loader2, Store } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCancelPreOpening, usePreOpeningCancelPreview } from '@/lib/customers/hooks';
import { formatDate, formatEur } from '@/lib/format';

/** Fecha de inicio que se enseña: la de apertura o «pendiente de apertura». */
export function contractStartLabel(c: ContractDto): string {
  if (c.preOpening && !c.preOpening.startedAt) {
    return c.preOpening.openingDate
      ? `Apertura: ${formatDate(c.preOpening.openingDate)}`
      : 'Pendiente de apertura';
  }
  return formatDate(c.startDate);
}

/** Reserva antes de la apertura del local: fechas y cancelación. */
export function PreOpeningContractCard({ contract }: { contract: ContractDto }) {
  const po = contract.preOpening;
  const canManage = useHasPermission('contracts:manage');
  const pending =
    !!po && !po.startedAt && contract.status !== 'cancelled' && contract.status !== 'ended';
  const [asked, setAsked] = useState(false);
  const preview = usePreOpeningCancelPreview(contract.id, pending && asked);
  const cancel = useCancelPreOpening(contract.id);
  const confirm = useConfirm();
  if (!po || !pending) return null;

  async function onCancel() {
    setAsked(true);
    const p = preview.data ?? (await preview.refetch()).data;
    if (!p) return;
    const parts = [
      p.rentAmount > 0 ? `Se devuelve la primera mensualidad (${formatEur(p.rentAmount)}).` : null,
      p.depositAmount > 0
        ? p.refundDeposit
          ? `Se devuelve la fianza (${formatEur(p.depositAmount)}).`
          : `La fianza (${formatEur(p.depositAmount)}) se queda como arras: han pasado los 14 días de desistimiento.`
        : null,
      'El trastero vuelve a estar libre.',
    ].filter(Boolean);
    const ok = await confirm({
      title: 'Cancelar la reserva',
      description: parts.join(' '),
      confirmLabel: 'Cancelar la reserva',
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(undefined);
      toast.success('Reserva cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  return (
    <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-900 dark:bg-sky-950/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Store className="size-4" />
          Reserva antes de la apertura
        </CardTitle>
        <CardDescription>
          El alquiler empieza el día que abra el local: hasta entonces el trastero queda reservado,
          sin acceso y sin cuotas. La primera mensualidad pagada cubre el primer mes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">Apertura: </span>
            {po.openingDate ? formatDate(po.openingDate) : 'por confirmar'}
          </p>
          {po.deadline && (
            <p>
              <span className="text-muted-foreground">Fecha límite: </span>
              {formatDate(po.deadline)}
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          La fecha de apertura se cambia en los ajustes del local. Para cambiarle el trastero,
          «Trasladar» admite otro del mismo local y del mismo precio.
        </p>
        {canManage && contract.status !== 'draft' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCancel()}
            disabled={cancel.isPending || preview.isFetching}
          >
            {(cancel.isPending || preview.isFetching) && (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            )}
            Cancelar la reserva
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
