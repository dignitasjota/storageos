'use client';

import { Loader2, Send, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  SepaPrenoticeStatus,
  SepaRemittanceDto,
  SepaRemittanceItemStatus,
  SepaRemittancePrenoticeDto,
  SepaReturnCode,
} from '@storageos/shared';

import { ReturnCodeSelect } from '@/components/billing/return-code-select';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { formatDateTime, formatEur } from '@/lib/format';
import {
  useMarkSepaItemReturned,
  useRemittancePrenotices,
  useResendPrenotices,
} from '@/lib/sepa/hooks';

const STATUS: Record<SepaPrenoticeStatus, { label: string; className: string }> = {
  sent: {
    label: 'Preaviso enviado',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  disabled: {
    label: 'Sin preaviso: correo desactivado',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  no_email: {
    label: 'Sin preaviso: el inquilino no tiene email',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  failed: {
    label: 'Error al enviar el preaviso',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
};

/** Estado del adeudo (cobro), aparte del preaviso. */
export const ITEM_STATUS: Record<SepaRemittanceItemStatus, { label: string; className: string }> = {
  pending: { label: 'Pendiente del banco', className: '' },
  collected: {
    label: 'Cobrado',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  failed: {
    label: 'Rechazado por el banco',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  unapplied: {
    label: 'Cobrado sin aplicar: a devolver',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  returned: {
    label: 'Devuelto por el banco',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  cancelled: { label: 'Remesa cancelada', className: '' },
};

const DELIVERY: Record<string, string> = {
  delivered: 'entregado',
  bounced: 'rebotado',
  failed: 'fallido',
  sent: 'enviado al proveedor',
  pending: 'en cola',
  processing: 'enviándose',
  skipped: 'omitido',
};

/**
 * Adeudos de la remesa y la constancia del preaviso de cada uno (prueba ante
 * una devolución: el deudor puede reclamar un adeudo no autorizado hasta 13
 * meses después). Desde aquí se marca devuelto un adeudo que el banco
 * devolvió y se reenvían los preavisos que no salieron.
 */
export function PrenoticesDialog({
  remittance,
  onClose,
}: {
  remittance: SepaRemittanceDto | null;
  onClose: () => void;
}) {
  const q = useRemittancePrenotices(remittance?.id ?? null);
  const resend = useResendPrenotices();
  const canManage = useHasPermission('invoices:manage');
  const [returning, setReturning] = useState<SepaRemittancePrenoticeDto | null>(null);
  const missing = (q.data ?? []).filter(
    (p) =>
      p.itemStatus === 'pending' &&
      (p.status === null || p.status === 'failed' || p.status === 'no_email'),
  ).length;

  async function onResend() {
    if (!remittance) return;
    try {
      const r = await resend.mutateAsync(remittance.id);
      toast.success(
        r.resent > 0 ? `Reenviando ${r.resent} preaviso(s).` : 'No había preavisos que reenviar.',
      );
      void q.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron reenviar.');
    }
  }

  return (
    <Dialog open={!!remittance} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adeudos y preavisos · {remittance?.name}</DialogTitle>
          <DialogDescription>
            Lo que se avisó a cada deudor antes del cargo y cómo quedó cada adeudo. Se guarda con la
            remesa como prueba si un inquilino devuelve el adeudo.
          </DialogDescription>
        </DialogHeader>
        {canManage && remittance?.status === 'generated' && missing > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={resend.isPending}
            onClick={() => void onResend()}
          >
            <Send className="mr-1 h-3 w-3" /> Reenviar los {missing} preavisos que no salieron
          </Button>
        )}
        {q.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : q.isError ? (
          <p className="text-sm text-destructive">No se han podido cargar los adeudos.</p>
        ) : (
          <ul className="space-y-3">
            {(q.data ?? []).map((p) => (
              <li key={p.itemId} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/customers/${p.customerId}`} className="font-medium hover:underline">
                    {p.customerName || 'Inquilino'}
                  </Link>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline" className={ITEM_STATUS[p.itemStatus].className}>
                      {ITEM_STATUS[p.itemStatus].label}
                    </Badge>
                    {p.status ? (
                      <Badge variant="outline" className={STATUS[p.status].className}>
                        {STATUS[p.status].label}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Preaviso enviándose</Badge>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.invoiceNumber ? (
                    <Link href={`/invoices/${p.invoiceId}`} className="hover:underline">
                      Factura {p.invoiceNumber}
                    </Link>
                  ) : null}
                  {p.invoiceNumber ? ' · ' : ''}
                  {formatEur(p.amount)}
                  {p.at ? ` · ${formatDateTime(p.at)}` : ''}
                  {p.recipient ? ` · ${p.recipient}` : ''}
                  {p.deliveryStatus ? ` · ${DELIVERY[p.deliveryStatus] ?? p.deliveryStatus}` : ''}
                </p>
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {p.endToEndId} · mandato {p.mandateReference}
                </p>
                {p.failureReason && (
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">{p.failureReason}</p>
                )}
                {canManage && p.itemStatus === 'collected' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1"
                    onClick={() => setReturning(p)}
                  >
                    <Undo2 className="mr-1 h-3 w-3" /> El banco lo devolvió
                  </Button>
                )}
                {p.text && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Ver el aviso enviado
                    </summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">
                      {p.subject ? `${p.subject}\n\n` : ''}
                      {p.text}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {remittance && returning && (
          <ReturnItemDialog
            remittanceId={remittance.id}
            item={returning}
            onClose={() => setReturning(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReturnItemDialog({
  remittanceId,
  item,
  onClose,
}: {
  remittanceId: string;
  item: SepaRemittancePrenoticeDto;
  onClose: () => void;
}) {
  const mark = useMarkSepaItemReturned();
  const [reason, setReason] = useState('');
  const [returnCode, setReturnCode] = useState<SepaReturnCode | null>(null);
  const [returnedOn, setReturnedOn] = useState(localDateString());

  async function submit() {
    try {
      await mark.mutateAsync({
        remittanceId,
        itemId: item.itemId,
        input: {
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(returnCode ? { returnCode } : {}),
          ...(returnedOn ? { returnedOn } : {}),
        },
      });
      toast.success('Devolución registrada: la factura vuelve a estar pendiente.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>El banco devolvió el adeudo</DialogTitle>
          <DialogDescription>
            {item.customerName} · {formatEur(item.amount)}. El cobro deja de contar, la factura
            vuelve a estar pendiente y puede ir en otra remesa.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Día de la devolución</Label>
            <DateSelect
              value={returnedOn}
              onChange={(v) => setReturnedOn(v ?? localDateString())}
            />
          </div>
          <div className="space-y-1">
            <Label>Código de devolución</Label>
            <ReturnCodeSelect value={returnCode} onChange={setReturnCode} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ret-reason">Otro motivo que da el banco (opcional)</Label>
            <Input
              id="ret-reason"
              value={reason}
              maxLength={200}
              placeholder="Lo que diga el banco si no hay código"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" disabled={mark.isPending} onClick={() => void submit()}>
            Registrar la devolución
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
