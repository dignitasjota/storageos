'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useInvoices } from '@/lib/billing/hooks';
import {
  useCollectDeposit,
  useSetDepositPaymentMethod,
  useSettleDeposit,
} from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';

const RETURN_METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'transferencia',
  cash: 'efectivo',
  card: 'tarjeta',
  other: 'otro medio',
};

const DEPOSIT_STATUS_LABEL: Record<string, string> = {
  none: 'Sin fianza',
  held: 'Retenida',
  returned: 'Devuelta',
  partially_returned: 'Devuelta parcialmente',
};

export function depositStatusLabel(status: string): string {
  return DEPOSIT_STATUS_LABEL[status] ?? status;
}

/** Estado de la fianza tal como se ha cobrado de verdad. */
export function contractDepositLabel(c: ContractDto): string {
  if (c.depositStatus === 'held' && !c.depositCollected) return 'Pendiente de cobro';
  return depositStatusLabel(c.depositStatus);
}

/**
 * Ciclo de vida de la fianza: cuando está retenida (`held`) permite liquidarla
 * al finalizar (devolver total/parcial + retener por daños/deuda). Muestra la
 * deuda pendiente del contrato para ayudar a decidir cuánto retener.
 */
export function DepositCard({ contract }: { contract: ContractDto }) {
  const [open, setOpen] = useState(false);
  const collect = useCollectDeposit();
  const setMethod = useSetDepositPaymentMethod();
  const [collectMethod, setCollectMethod] = useState<'cash' | 'card' | 'bank_transfer' | 'other'>(
    'cash',
  );
  const receipt = contract.depositReceipt;
  const collected = receipt?.status === 'paid';
  const live = contract.status !== 'cancelled' && contract.status !== 'ended';

  async function onCollect() {
    try {
      await collect.mutateAsync({ id: contract.id, body: { methodType: collectMethod } });
      toast.success('Cobro de la fianza registrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar el cobro.');
    }
  }

  async function onChangeMethod(method: 'online' | 'cash') {
    try {
      await setMethod.mutateAsync({ id: contract.id, method });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  // No mostramos nada si el contrato no lleva fianza.
  if (contract.depositAmount <= 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fianza</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Importe</span>
          <span className="font-semibold tabular-nums">{formatEur(contract.depositAmount)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Estado</span>
          <span>{contractDepositLabel(contract)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Cobro</span>
          {contract.status === 'draft' ? (
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={contract.depositPaymentMethod}
              disabled={setMethod.isPending}
              onChange={(e) => void onChangeMethod(e.target.value as 'online' | 'cash')}
            >
              <option value="online">Con la 1ª factura (online)</option>
              <option value="cash">En el local (efectivo o TPV)</option>
            </select>
          ) : (
            <span>
              {contract.depositPaymentMethod === 'cash'
                ? 'En el local (efectivo o TPV)'
                : 'Con la 1ª factura'}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Justificante</span>
          <span>
            {receipt ? (
              <>
                {receipt.number} · {collected ? 'cobrado' : 'pendiente de cobro'}
              </>
            ) : (
              'aún no emitido'
            )}
          </span>
        </div>

        {live && !collected && (
          <Can permission="payments:charge">
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={collectMethod}
                onChange={(e) =>
                  setCollectMethod(e.target.value as 'cash' | 'card' | 'bank_transfer' | 'other')
                }
              >
                <option value="cash">Efectivo</option>
                <option value="card">Tarjeta (TPV físico)</option>
                <option value="bank_transfer">Transferencia</option>
                <option value="other">Otro</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onCollect()}
                disabled={collect.isPending}
              >
                Registrar cobro de la fianza
              </Button>
            </div>
          </Can>
        )}

        {(contract.depositStatus === 'returned' ||
          contract.depositStatus === 'partially_returned') && (
          <div className="space-y-1 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Devuelto</span>
              <span className="tabular-nums">{formatEur(contract.depositReturnedAmount)}</span>
            </div>
            <div className="flex justify-between">
              <span>Retenido</span>
              <span className="tabular-nums">
                {formatEur(contract.depositAmount - contract.depositReturnedAmount)}
              </span>
            </div>
            {contract.depositRetentionReason && (
              <div>Motivo: {contract.depositRetentionReason}</div>
            )}
            {contract.depositAppliedAmount > 0 && (
              <div>Aplicado a facturas: {formatEur(contract.depositAppliedAmount)}</div>
            )}
            {contract.depositReturnMethod && (
              <div>
                Devuelta por {RETURN_METHOD_LABEL[contract.depositReturnMethod] ?? 'otro medio'}
                {contract.depositReturnedOn && ` el ${formatDate(contract.depositReturnedOn)}`}
                {contract.depositReturnReference && ` · ${contract.depositReturnReference}`}
              </div>
            )}
            {contract.depositSettledAt && (
              <div>Liquidada el {formatDate(contract.depositSettledAt)}</div>
            )}
          </div>
        )}

        {contract.depositStatus === 'held' &&
          (contract.depositCollected || (!live && !receipt)) && (
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

export function SettleDepositDialog({
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
  const [applyToInvoices, setApplyToInvoices] = useState(false);
  const [returnMethod, setReturnMethod] = useState<'bank_transfer' | 'cash' | 'card' | 'other'>(
    'bank_transfer',
  );
  const [returnedOn, setReturnedOn] = useState(localDateString());
  const [returnReference, setReturnReference] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

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
        body: {
          returnedAmount,
          ...(reason.trim() ? { retentionReason: reason.trim() } : {}),
          ...(applyToInvoices ? { applyToInvoices } : {}),
          ...(returnedAmount > 0
            ? {
                returnMethod,
                returnedOn,
                ...(returnReference.trim() ? { returnReference: returnReference.trim() } : {}),
              }
            : {}),
          ...(notifyCustomer ? { notifyCustomer } : {}),
        },
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
            Fianza retenida: <strong>{formatEur(contract.depositAmount)}</strong>. Indica cuánto
            devuelves al inquilino; el resto se retiene (indica el motivo).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {pending > 0 && (
            <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Este contrato tiene <strong>{formatEur(pending)}</strong> de facturas pendientes.
              Puedes retener ese importe de la fianza.
              <button
                type="button"
                className="ml-1 underline"
                onClick={() => {
                  setReturnedAmount(Math.max(0, contract.depositAmount - pending));
                  setReason('Facturas pendientes');
                  setApplyToInvoices(true);
                }}
              >
                Retener lo pendiente
              </button>
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
            <p className="mt-1 text-xs text-muted-foreground">Se retienen {formatEur(retained)}</p>
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
          {retained > 0 && pending > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={applyToInvoices}
                onCheckedChange={(v) => setApplyToInvoices(v === true)}
              />
              <span>
                Aplicar lo retenido a las facturas pendientes, de la más antigua a la última
              </span>
            </label>
          )}
          {returnedAmount > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Cómo se devuelve</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={returnMethod}
                  onChange={(e) =>
                    setReturnMethod(e.target.value as 'bank_transfer' | 'cash' | 'card' | 'other')
                  }
                >
                  <option value="bank_transfer">Transferencia</option>
                  <option value="cash">Efectivo</option>
                  <option value="card">Tarjeta</option>
                  <option value="other">Otro</option>
                </select>
              </div>
              <div>
                <Label>Fecha</Label>
                <Input
                  type="date"
                  value={returnedOn}
                  onChange={(e) => setReturnedOn(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label>Referencia (opcional)</Label>
                <Input
                  value={returnReference}
                  onChange={(e) => setReturnReference(e.target.value)}
                  placeholder="Nº de transferencia…"
                />
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={notifyCustomer}
              onCheckedChange={(v) => setNotifyCustomer(v === true)}
            />
            Enviar el justificante al inquilino por correo
          </label>
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
