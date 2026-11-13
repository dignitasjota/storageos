'use client';

import {
  CASH_MOVEMENT_LABELS,
  CASH_MOVEMENT_SIGN,
  CashMovementKindEnum,
  type CashDaySummaryDto,
  type CashManualMovementKind,
} from '@storageos/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useAddCashMovement, useDeleteCashMovement } from '@/lib/cash/hooks';
import { formatEur } from '@/lib/format';

/** «12,50» o «12.50» → euros; null si no es un importe. */
function parseAmount(v: string): number | null {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * Lo que entra o sale del cajón sin ser un cobro: el fondo con el que se abre,
 * el cambio que se trae y lo que se lleva al banco. Cuenta en el esperado.
 */
export function CashMovementsCard({
  date,
  facilityId,
  summary,
}: {
  date: string;
  facilityId: string;
  summary: CashDaySummaryDto;
}) {
  const add = useAddCashMovement();
  const remove = useDeleteCashMovement();
  const ask = useConfirm();
  const canEdit = useHasPermission('payments:charge');
  const closed = !!summary.closure;
  const hasFloat = summary.movements.some((m) => m.kind === 'opening_float');
  const [kind, setKind] = useState<CashManualMovementKind>(
    hasFloat ? 'bank_withdrawal' : 'opening_float',
  );
  const [amount, setAmount] = useState(
    !hasFloat && summary.lastOpeningFloat ? String(summary.lastOpeningFloat).replace('.', ',') : '',
  );
  const [notes, setNotes] = useState('');
  const parsed = amount ? parseAmount(amount) : null;

  async function submit() {
    if (parsed === null) {
      toast.error('Introduce un importe (por ejemplo, 100 o 50,00).');
      return;
    }
    try {
      await add.mutateAsync({
        date,
        kind,
        amount: parsed,
        ...(facilityId ? { facilityId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(`${CASH_MOVEMENT_LABELS[kind]} registrado.`);
      setAmount('');
      setNotes('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  async function onDelete(id: string, label: string) {
    if (!(await ask({ title: `¿Quitar «${label}»?`, destructive: true }))) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Movimiento quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fondo y movimientos de caja</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {summary.movements.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ningún movimiento este día. Apunta aquí el fondo con el que abres, el cambio que traes y
            lo que llevas al banco: cuentan en el efectivo esperado.
          </p>
        ) : (
          <ul className="divide-y">
            {summary.movements.map((m) => {
              const sign = CASH_MOVEMENT_SIGN[m.kind];
              return (
                <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <p>
                      {CASH_MOVEMENT_LABELS[m.kind]}
                      {!facilityId && m.facilityName && (
                        <span className="text-muted-foreground"> · {m.facilityName}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[m.notes, m.createdByName].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span
                      className={`tabular-nums ${sign < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}`}
                    >
                      {sign < 0 ? '−' : '+'}
                      {formatEur(m.amount)}
                    </span>
                    {canEdit && !closed && m.kind !== 'expense_payment' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Quitar el movimiento"
                        disabled={remove.isPending}
                        onClick={() => void onDelete(m.id, CASH_MOVEMENT_LABELS[m.kind])}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {canEdit &&
          (closed ? (
            <p className="text-xs text-muted-foreground">
              La caja de este día está cerrada: para añadir o quitar un movimiento, reábrela.
            </p>
          ) : (
            <div className="space-y-2 border-t pt-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1">
                  <Label className="text-xs">Movimiento</Label>
                  <Select value={kind} onValueChange={(v) => setKind(v as CashManualMovementKind)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CashMovementKindEnum.options.map((k) => (
                        <SelectItem key={k} value={k}>
                          {CASH_MOVEMENT_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="movement-amount">
                    Importe (€)
                  </Label>
                  <Input
                    id="movement-amount"
                    inputMode="decimal"
                    placeholder="0,00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>
              <Input
                placeholder="Nota (opcional): «ingreso en el banco», «cambio de 20 €»…"
                maxLength={300}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {amount && parsed === null && (
                <p className="text-xs text-destructive">Importe no válido.</p>
              )}
              <Button size="sm" disabled={add.isPending || !amount} onClick={() => void submit()}>
                Añadir
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
