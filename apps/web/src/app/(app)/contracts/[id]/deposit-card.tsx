'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useInvoices } from '@/lib/billing/hooks';
import { useSettleDeposit } from '@/lib/customers/hooks';

const DEPOSIT_STATUS_LABEL: Record<string, string> = {
  none: 'Sin fianza',
  held: 'Retenida',
  returned: 'Devuelta',
  partially_returned: 'Devuelta parcialmente',
};

export function depositStatusLabel(status: string): string {
  return DEPOSIT_STATUS_LABEL[status] ?? status;
}

/**
 * Ciclo de vida de la fianza: cuando está retenida (`held`) permite liquidarla
 * al finalizar (devolver total/parcial + retener por daños/deuda). Muestra la
 * deuda pendiente del contrato para ayudar a decidir cuánto retener.
 */
export function DepositCard({ contract }: { contract: ContractDto }) {
  const [open, setOpen] = useState(false);

  // No mostramos nada si el contrato no lleva fianza.
  if (contract.depositAmount <= 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fianza</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Importe retenido</span>
          <span className="font-semibold tabular-nums">{contract.depositAmount.toFixed(2)} €</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Estado</span>
          <span>{depositStatusLabel(contract.depositStatus)}</span>
        </div>

        {(contract.depositStatus === 'returned' ||
          contract.depositStatus === 'partially_returned') && (
          <div className="space-y-1 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Devuelto</span>
              <span className="tabular-nums">{contract.depositReturnedAmount.toFixed(2)} €</span>
            </div>
            <div className="flex justify-between">
              <span>Retenido</span>
              <span className="tabular-nums">
                {(contract.depositAmount - contract.depositReturnedAmount).toFixed(2)} €
              </span>
            </div>
            {contract.depositRetentionReason && (
              <div>Motivo: {contract.depositRetentionReason}</div>
            )}
            {contract.depositSettledAt && (
              <div>
                Liquidada el {new Date(contract.depositSettledAt).toLocaleDateString('es-ES')}
              </div>
            )}
          </div>
        )}

        {contract.depositStatus === 'held' && (
          <Can permission="contracts:manage">
            <Button size="sm" variant="outline" className="mt-1" onClick={() => setOpen(true)}>
              Liquidar fianza
            </Button>
          </Can>
        )}
      </CardContent>

      <SettleDepositDialog contract={contract} open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function SettleDepositDialog({
  contract,
  open,
  onClose,
}: {
  contract: ContractDto;
  open: boolean;
  onClose: () => void;
}) {
  const settle = useSettleDeposit();
  const [returnedAmount, setReturnedAmount] = useState(contract.depositAmount);
  const [reason, setReason] = useState('');

  // Deuda pendiente del contrato (para decidir cuánto retener).
  const invoices = useInvoices({ contractId: contract.id });
  const pending = (invoices.data ?? [])
    .filter((i) => i.status === 'issued' || i.status === 'overdue')
    .reduce((sum, i) => sum + i.amountPending, 0);

  const retained = Math.max(0, contract.depositAmount - returnedAmount);

  async function onSubmit() {
    try {
      await settle.mutateAsync({
        id: contract.id,
        body: { returnedAmount, ...(reason.trim() ? { retentionReason: reason.trim() } : {}) },
      });
      toast.success('Fianza liquidada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo liquidar la fianza.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Liquidar fianza</DialogTitle>
          <DialogDescription>
            Fianza retenida: <strong>{contract.depositAmount.toFixed(2)} €</strong>. Indica cuánto
            devuelves al inquilino; el resto se retiene (indica el motivo).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {pending > 0 && (
            <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Este contrato tiene <strong>{pending.toFixed(2)} €</strong> de facturas pendientes.
              Puedes retener ese importe de la fianza.
            </div>
          )}
          <div>
            <Label>Importe a devolver (€)</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              max={contract.depositAmount}
              value={returnedAmount}
              onChange={(e) => setReturnedAmount(Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Se retienen {retained.toFixed(2)} €
            </p>
          </div>
          {retained > 0 && (
            <div>
              <Label>Motivo de la retención</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Daños en el trastero, facturas impagadas…"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={onSubmit}
            disabled={settle.isPending || (retained > 0 && !reason.trim())}
          >
            Liquidar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
