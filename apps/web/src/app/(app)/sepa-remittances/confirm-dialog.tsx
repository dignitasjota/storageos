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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatEur } from '@/lib/format';
import { useConfirmRemittance, useRemittancePrenotices } from '@/lib/sepa/hooks';

/**
 * Registrar el resultado del banco: se marcan los adeudos que rechazó (no se
 * cobran y pueden ir en otra remesa); el resto queda cobrado con la fecha del
 * cargo. Sirve también para terminar un registro que se cortó a medias.
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
      if (r.unappliedCount > 0) {
        toast.warning(
          `${r.collectedCount} cobrados y ${r.unappliedCount} que el banco cobró pero sus facturas ya estaban pagadas o anuladas: devuelve ese dinero (lo ves en «Preavisos»).`,
          { duration: 12_000 },
        );
      } else if (r.failedCount > 0) {
        toast.success(`${r.collectedCount} cobrados y ${r.failedCount} rechazados por el banco.`);
      } else {
        toast.success(`Resultado registrado: ${r.collectedCount} facturas cobradas.`);
      }
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  const pending = (items.data ?? []).filter((i) => i.itemStatus === 'pending');
  const rejectedTotal = pending
    .filter((i) => rejected.has(i.itemId))
    .reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const total = pending.reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const resuming = remittance?.status === 'confirmed';

  return (
    <Dialog open={!!remittance} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {resuming ? 'Terminar de registrar' : 'Resultado del banco'} · {remittance?.name}
          </DialogTitle>
          <DialogDescription>
            {resuming
              ? 'El registro anterior se cortó: marca otra vez los que el banco rechazó y termina.'
              : `Cargo del ${formatDate(remittance?.collectionDate)}. Marca los adeudos que el banco rechazó (los identifica por su referencia); el resto quedará cobrado con esa fecha.`}
          </DialogDescription>
        </DialogHeader>
        {items.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queda ningún adeudo por registrar.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((i) => (
              <li key={i.itemId} className="flex items-start gap-3 rounded-md border p-2 text-sm">
                <Checkbox
                  id={`rej-${i.itemId}`}
                  className="mt-0.5"
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
                <label htmlFor={`rej-${i.itemId}`} className="min-w-0 flex-1 cursor-pointer">
                  <span className="font-medium">{i.customerName || 'Inquilino'}</span>
                  <span className="block text-xs text-muted-foreground">
                    {i.invoiceNumber ? `Factura ${i.invoiceNumber} · ` : ''}
                    {formatEur(i.amount)} ·{' '}
                    {rejected.has(i.itemId) ? 'rechazado por el banco' : 'cobrado'}
                  </span>
                  <span className="block break-all font-mono text-[11px] text-muted-foreground">
                    {i.endToEndId} · mandato {i.mandateReference}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {pending.length > 0 && (
          <p className="text-sm">
            Cobrado: <strong>{formatEur((total - rejectedTotal) / 100)}</strong>
            {rejected.size > 0 && (
              <>
                {' '}
                · Rechazado: <strong>{formatEur(rejectedTotal / 100)}</strong> ({rejected.size})
              </>
            )}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Volver
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={confirmMut.isPending || items.isLoading || pending.length === 0}
          >
            {confirmMut.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Registrar
            {rejected.size > 0 ? ` (${pending.length - rejected.size} de ${pending.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
