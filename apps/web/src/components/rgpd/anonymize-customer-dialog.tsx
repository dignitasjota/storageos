'use client';

import { AlertTriangle, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AnonymizePreviewItemDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
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
import { formatEur } from '@/lib/format';
import { useAnonymizeCustomer, useAnonymizePreview } from '@/lib/rgpd/hooks';

interface Props {
  customerId: string | null;
  /** Solicitud de supresión que queda atendida al anonimizar. */
  requestId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

function ItemList({ items }: { items: AnonymizePreviewItemDto[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <span className="font-medium">{i.label}</span>
          {i.count !== null && <span className="text-muted-foreground"> · {i.count}</span>}
          {i.note && <p className="text-xs text-muted-foreground">{i.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Anonimizar a un inquilino con vista previa: qué se borra, qué se conserva
 * por ley y qué lo impide. Con deuda pide marcar que se sabe.
 */
export function AnonymizeCustomerDialog({
  customerId,
  requestId,
  open,
  onOpenChange,
  onDone,
}: Props) {
  const preview = useAnonymizePreview(customerId, open);
  const anonymize = useAnonymizeCustomer();
  const [debtOk, setDebtOk] = useState(false);
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    if (!open) {
      setDebtOk(false);
      setUnderstood(false);
    }
  }, [open]);

  const data = preview.data;
  const debt = data?.blockers.debt ?? 0;
  const ready = !!data && data.canAnonymize && understood && (debt <= 0 || debtOk);

  async function confirm() {
    if (!customerId || !data) return;
    try {
      await anonymize.mutateAsync({
        customerId,
        ...(requestId ? { requestId } : {}),
        ...(debt > 0 ? { confirmDebt: true } : {}),
      });
      toast.success(
        requestId ? 'Inquilino anonimizado y solicitud atendida.' : 'Inquilino anonimizado.',
      );
      onOpenChange(false);
      onDone?.();
    } catch (err) {
      // Algo cambió mientras se revisaba (una factura nueva, una reserva…).
      void preview.refetch();
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo anonimizar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Anonimizar {data ? `a ${data.customerName}` : 'al inquilino'}</DialogTitle>
          <DialogDescription>
            Se borran sus datos personales y se conserva lo que la ley obliga a guardar. No se puede
            deshacer.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : preview.isError || !data ? (
          <SectionError onRetry={() => void preview.refetch()} />
        ) : (
          <div className="space-y-4">
            {(data.blockers.liveContracts > 0 || data.blockers.reservations > 0) && (
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertTriangle className="size-4" /> Ahora no se puede anonimizar
                </p>
                {data.blockers.liveContracts > 0 && (
                  <p>
                    Tiene {data.blockers.liveContracts}{' '}
                    {data.blockers.liveContracts === 1 ? 'contrato en vigor' : 'contratos en vigor'}
                    : termínalos antes.
                  </p>
                )}
                {data.blockers.reservations > 0 && (
                  <p>
                    Tiene {data.blockers.reservations}{' '}
                    {data.blockers.reservations === 1 ? 'reserva en curso' : 'reservas en curso'}:
                    cancélalas antes.
                  </p>
                )}
              </div>
            )}
            {data.canAnonymize && data.blockers.draftContracts > 0 && (
              <p className="rounded-md border p-3 text-sm text-muted-foreground">
                {data.blockers.draftContracts === 1
                  ? 'Tiene un contrato sin firmar: se cancelará y se soltará el trastero.'
                  : `Tiene ${data.blockers.draftContracts} contratos sin firmar: se cancelarán y se soltarán los trasteros.`}
              </p>
            )}

            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Trash2 className="size-4" /> Se borra
              </h3>
              <ItemList items={data.deleted} />
            </section>
            {data.kept.length > 0 && (
              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <ShieldCheck className="size-4" /> Se conserva
                </h3>
                <ItemList items={data.kept} />
              </section>
            )}

            {data.canAnonymize && (
              <div className="space-y-2 border-t pt-3">
                {debt > 0 && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={debtOk}
                      onCheckedChange={(v) => setDebtOk(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Debe <strong>{formatEur(debt)}</strong>. Sé que las facturas se conservan pero
                      ya no podré reclamárselas a su nombre.
                    </span>
                  </label>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={understood}
                    onCheckedChange={(v) => setUnderstood(v === true)}
                    className="mt-0.5"
                  />
                  <span>Entiendo que no se puede deshacer.</span>
                </label>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!ready || anonymize.isPending}
            onClick={() => void confirm()}
          >
            {anonymize.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Anonimizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
