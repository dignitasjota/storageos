'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import type { SepaPrenoticeStatus, SepaRemittanceDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRemittancePrenotices } from '@/lib/sepa/hooks';

const STATUS: Record<SepaPrenoticeStatus, { label: string; className: string }> = {
  sent: {
    label: 'Enviado',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  disabled: {
    label: 'No enviado: preaviso desactivado',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  no_email: {
    label: 'No enviado: el inquilino no tiene email',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  failed: {
    label: 'Error al enviar',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
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
 * Constancia del preaviso de cada adeudo: prueba ante una devolución (el
 * deudor puede reclamar un adeudo no autorizado hasta 13 meses después).
 */
export function PrenoticesDialog({
  remittance,
  onClose,
}: {
  remittance: SepaRemittanceDto | null;
  onClose: () => void;
}) {
  const q = useRemittancePrenotices(remittance?.id ?? null);
  return (
    <Dialog open={!!remittance} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preavisos · {remittance?.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Lo que se avisó a cada deudor antes del cargo. Se guarda con la remesa como prueba si un
          inquilino devuelve el adeudo.
        </p>
        {q.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="space-y-3">
            {(q.data ?? []).map((p) => (
              <li key={p.itemId} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/customers/${p.customerId}`} className="font-medium hover:underline">
                    {p.customerName || 'Inquilino'}
                  </Link>
                  {p.status ? (
                    <Badge variant="outline" className={STATUS[p.status].className}>
                      {STATUS[p.status].label}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Pendiente</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.invoiceNumber ? `Factura ${p.invoiceNumber} · ` : ''}
                  {p.amount.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                  {p.at ? ` · ${new Date(p.at).toLocaleString('es-ES')}` : ''}
                  {p.recipient ? ` · ${p.recipient}` : ''}
                  {p.deliveryStatus ? ` · ${DELIVERY[p.deliveryStatus] ?? p.deliveryStatus}` : ''}
                </p>
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
      </DialogContent>
    </Dialog>
  );
}
