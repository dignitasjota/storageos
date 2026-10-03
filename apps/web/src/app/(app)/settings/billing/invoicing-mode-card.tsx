'use client';

import { CalendarClock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { InvoicingModeValue } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useInvoicingMode, useUpdateInvoicingMode } from '@/lib/accounting/hooks';
import { ApiError } from '@/lib/auth/api';

const LABELS: Record<InvoicingModeValue, string> = {
  app: 'TrasterOS (Veri*Factu)',
  holded: 'Holded',
};

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Dónde se emiten las facturas: en TrasterOS (numeración propia y registro en
 * Veri*Factu con el certificado del tenant) o en Holded (Holded numera y
 * registra). No se cambia en mitad del año.
 */
export function InvoicingModeCard() {
  const q = useInvoicingMode();
  const update = useUpdateInvoicingMode();
  const data = q.data;

  async function choose(mode: InvoicingModeValue) {
    if (!data) return;
    const target = data.pendingMode ?? data.mode;
    if (mode === target) return;
    const scheduled = mode !== data.mode && !data.canChangeNow;
    const msg = scheduled
      ? `Ya has emitido facturas este año: el cambio a ${LABELS[mode]} se aplicará el 1 de enero. ¿Continuar?`
      : mode === data.mode
        ? `¿Anular el cambio programado y seguir con ${LABELS[mode]}?`
        : `A partir de ahora tus facturas se emitirán en ${LABELS[mode]}. No podrás cambiarlo hasta el año que viene una vez emitas la primera. ¿Continuar?`;
    if (!window.confirm(msg)) return;
    try {
      await update.mutateAsync(mode);
      toast.success('Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dónde se emiten tus facturas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="space-y-2" role="radiogroup">
              <label className="flex items-start gap-3 rounded-md border p-3">
                <input
                  type="radio"
                  name="invoicing-mode"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={(data.pendingMode ?? data.mode) === 'app'}
                  disabled={update.isPending}
                  onChange={() => void choose('app')}
                />
                <div className="text-sm">
                  <p className="font-medium">En TrasterOS, con Veri*Factu</p>
                  <p className="text-muted-foreground">
                    TrasterOS numera tus facturas y las registra en la AEAT con tu certificado
                    digital (súbelo en Veri*Factu). Holded, si lo usas, solo recibe una copia para
                    la contabilidad.
                  </p>
                  {data.mode === 'app' && data.certificateMissing && (
                    <p className="mt-1 text-amber-700 dark:text-amber-300">
                      Falta subir tu certificado digital: sin él no se pueden emitir facturas.
                    </p>
                  )}
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-md border p-3">
                <input
                  type="radio"
                  name="invoicing-mode"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={(data.pendingMode ?? data.mode) === 'holded'}
                  disabled={update.isPending || (!data.holdedReady && data.mode !== 'holded')}
                  onChange={() => void choose('holded')}
                />
                <div className="text-sm">
                  <p className="font-medium">En Holded</p>
                  <p className="text-muted-foreground">
                    Al emitir aquí, la factura se crea en tu Holded: Holded la numera, la registra
                    en Veri*Factu y su PDF es el oficial. Los cobros también se anotan allí.
                  </p>
                  {!data.holdedReady && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Configura abajo tu Holded y elige las series para emitir.
                    </p>
                  )}
                </div>
              </label>
            </div>
            {data.pendingMode && data.pendingFrom && (
              <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                <CalendarClock className="h-4 w-4" />
                Cambio programado: desde el {formatDate(data.pendingFrom)} se emitirán en{' '}
                {LABELS[data.pendingMode]}. Hasta entonces, en {LABELS[data.mode]}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              No se puede cambiar en mitad del año (la numeración y el registro en la AEAT no pueden
              partirse): si ya has emitido facturas, el cambio se aplica el 1 de enero. La
              exportación para tu asesoría está disponible en cualquier caso.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
