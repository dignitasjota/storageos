'use client';

import {
  allocateOldestFirst,
  type ArrearsRowDto,
  type ManualPaymentMethodValue,
} from '@storageos/shared';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { useDebtorPayment } from '@/lib/collections-ops/hooks';
import { formatEur } from '@/lib/format';

const METHOD_LABELS: Record<ManualPaymentMethodValue, string> = {
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  bizum: 'Bizum',
  card: 'Tarjeta (TPV del local)',
  sepa_debit: 'Domiciliación SEPA',
  other: 'Otro (cheque…)',
};

const toCents = (eur: number) => Math.round(eur * 100);

/**
 * Pago recibido de un deudor: el importe se reparte entre sus facturas
 * vencidas, de la más antigua a la más nueva. Pagar solo una parte de una
 * factura se admite en efectivo, como en la ficha de la factura.
 */
export function DebtorPaymentDialog({
  row,
  onOpenChange,
}: {
  row: ArrearsRowDto;
  onOpenChange: (open: boolean) => void;
}) {
  const pay = useDebtorPayment();
  const [amount, setAmount] = useState(row.amount);
  const [method, setMethod] = useState<ManualPaymentMethodValue>('bank_transfer');

  const plan = useMemo(
    () =>
      allocateOldestFirst(
        row.invoices.map((i) => ({ ...i, pendingCents: toCents(i.pending) })),
        toCents(amount || 0),
      ),
    [row.invoices, amount],
  );
  const tooMuch = toCents(amount || 0) > toCents(row.amount);
  const partial = plan.some((x) => x.cents < x.invoice.pendingCents);
  const blocked = method !== 'cash' && partial;
  // Importes que cubren facturas enteras, para proponerlos si no es en efectivo.
  const wholeSteps = row.invoices.reduce<number[]>(
    (acc, i) => [...acc, (acc.at(-1) ?? 0) + toCents(i.pending)],
    [],
  );

  async function submit() {
    try {
      const res = await pay.mutateAsync({
        customerId: row.customerId,
        input: { amount, methodType: method },
      });
      if (res.failed) {
        toast.error(
          `${res.applied.length > 0 ? `Registrado en ${res.applied.length} ${res.applied.length === 1 ? 'factura' : 'facturas'}. ` : ''}En ${res.failed.invoiceNumber}: ${res.failed.error}`,
        );
      } else {
        toast.success(
          res.remaining > 0
            ? `Pago registrado. Aún debe ${formatEur(res.remaining)}.`
            : 'Pago registrado. Ya no debe nada vencido.',
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar el pago.');
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pago recibido de {row.customerName}</DialogTitle>
          <DialogDescription>
            Debe {formatEur(row.amount)} vencidos. Para dinero que ya has recibido: se aplica a las
            facturas más antiguas primero.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="debtor-amount">Importe (€)</Label>
              <Input
                id="debtor-amount"
                type="number"
                step="0.01"
                min={0}
                inputMode="decimal"
                value={Number.isNaN(amount) ? '' : amount}
                onChange={(e) => setAmount(e.target.valueAsNumber)}
              />
            </div>
            <div className="space-y-1">
              <Label>Forma de pago</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as ManualPaymentMethodValue)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METHOD_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {tooMuch ? (
            <p className="text-xs text-destructive">
              El importe supera lo que debe ({formatEur(row.amount)}).
            </p>
          ) : plan.length > 0 ? (
            <div className="rounded-md border p-3 text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Se aplicará a</p>
              <ul className="space-y-0.5">
                {plan.map(({ invoice, cents }) => (
                  <li key={invoice.id} className="flex justify-between gap-2 tabular-nums">
                    <span>{invoice.invoiceNumber}</span>
                    <span>
                      {cents < invoice.pendingCents
                        ? `${formatEur(cents / 100)} de ${formatEur(invoice.pending)}`
                        : formatEur(cents / 100)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {blocked && (
            <p className="text-xs text-destructive">
              Solo en efectivo se admite pagar una parte de una factura. Por otra vía, el importe
              tiene que cubrir facturas enteras:{' '}
              {wholeSteps.map((c) => formatEur(c / 100)).join(', ')}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!(amount > 0) || tooMuch || blocked || pay.isPending}
            onClick={() => void submit()}
          >
            Registrar pago
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
