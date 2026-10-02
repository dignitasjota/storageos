'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SepaRemittanceDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { useConfirmRemittance, useRemittancePrenotices } from '@/lib/sepa/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * Confirmar el cobro de una remesa: se marcan los adeudos que el banco
 * rechazó (no se cobran y pueden ir en otra remesa); el resto se da por cobrado.
 */
export function ConfirmRemittanceDialog({
  remittance,
  onClose,
}: {
  remittance: SepaRemittanceDto | null;
  onClose: () => void;
}) {
  const items = useRemittancePrenotices(remittance?.id ?? null);
  const confirmMut = useConfirmRemittance();
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  function close() {
    setRejected(new Set());
    onClose();
  }

  async function submit() {
    if (!remittance) return;
    try {
      const r = await confirmMut.mutateAsync({
        id: remittance.id,
        rejectedItemIds: [...rejected],
      });
      if (r.failedCount > 0) {
        toast.warning(
          `${r.collectedCount} cobrados y ${r.failedCount} sin cobrar. Revisa los adeudos fallidos en «Preavisos».`,
        );
      } else {
        toast.success(`Remesa confirmada: ${r.collectedCount} facturas cobradas.`);
      }
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const pending = (items.data ?? []).filter((i) => i.itemStatus === 'pending');

  return (
    <Dialog open={!!remittance} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Confirmar cobro · {remittance?.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Las facturas se marcarán como pagadas. Si el banco rechazó algún adeudo, márcalo: no se
          cobrará y podrás incluirlo en otra remesa.
        </p>
        {items.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="space-y-2">
            {pending.map((i) => (
              <li key={i.itemId} className="flex items-center gap-3 rounded-md border p-2 text-sm">
                <Checkbox
                  id={`rej-${i.itemId}`}
                  checked={rejected.has(i.itemId)}
                  onCheckedChange={(v) =>
                    setRejected((s) => {
                      const n = new Set(s);
                      if (v === true) n.add(i.itemId);
                      else n.delete(i.itemId);
                      return n;
                    })
                  }
                />
                <label htmlFor={`rej-${i.itemId}`} className="flex-1 cursor-pointer">
                  <span className="font-medium">{i.customerName || 'Inquilino'}</span>
                  <span className="block text-xs text-muted-foreground">
                    {i.invoiceNumber ? `Factura ${i.invoiceNumber} · ` : ''}
                    {eur(i.amount)} ·{' '}
                    {rejected.has(i.itemId) ? 'rechazado por el banco' : 'cobrado'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Volver
          </Button>
          <Button onClick={submit} disabled={confirmMut.isPending || items.isLoading}>
            {confirmMut.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Confirmar cobro
            {rejected.size > 0 ? ` (${pending.length - rejected.size} de ${pending.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
