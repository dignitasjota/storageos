'use client';

import { VERIFACTU_MANDATORY_FROM } from '@storageos/shared';
import { AlertTriangle, CheckCircle2, Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useUpdateVerifactuSettingsMutation,
  useVerifactuSettingsQuery,
} from '@/lib/billing/verifactu-hooks';
import { localDateString } from '@/lib/dates';

/** «1 de enero de 2027» (las fechas vienen como AAAA-MM-DD o ISO). */
function longDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Activar o desactivar el envío de las facturas a la AEAT. Apagado (por
 * defecto), las facturas salen sin QR y no se envían; cada negocio lo activa
 * cuando le toque.
 */
export function VerifactuSendingCard() {
  const settings = useVerifactuSettingsQuery();
  const update = useUpdateVerifactuSettingsMutation();
  const canConfigure = useHasPermission('billing:configure');
  const ask = useConfirm();

  if (settings.isLoading) return <Skeleton className="h-48 w-full" />;
  if (settings.isError || !settings.data) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertDescription>
          No se ha podido cargar el estado de Veri*Factu.{' '}
          <button type="button" className="underline" onClick={() => void settings.refetch()}>
            Reintentar
          </button>
        </AlertDescription>
      </Alert>
    );
  }
  const s = settings.data;
  const year = new Date().getFullYear();
  const locked = !!s.lockedUntil && localDateString() <= s.lockedUntil;

  async function change(enabled: boolean) {
    const ok = await ask(
      enabled
        ? {
            title: '¿Activar Veri*Factu?',
            description: `Desde ahora cada factura que emitas llevará el QR de la AEAT y se le enviará sola. No podrás desactivarlo hasta el 31 de diciembre de ${year}.`,
            confirmLabel: 'Activar',
          }
        : {
            title: '¿Desactivar Veri*Factu?',
            description:
              'Tus facturas dejarán de enviarse a la AEAT. Desde la fecha en que te toque es obligatorio: hazlo solo si ya no te corresponde.',
            confirmLabel: 'Desactivar',
            destructive: true,
          },
    );
    if (!ok) return;
    try {
      await update.mutateAsync({ enabled });
      toast.success(enabled ? 'Veri*Factu activado' : 'Veri*Factu desactivado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-center gap-2">
          <Send className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">Envío de tus facturas a la AEAT</CardTitle>
        </div>
        {s.enabled ? (
          <Badge className="bg-emerald-600 text-white hover:bg-emerald-600 dark:bg-emerald-500">
            Activado
          </Badge>
        ) : (
          <Badge variant="secondary">Sin activar</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {s.enabled ? (
          <>
            <p>
              {s.enabledAt ? `Activado desde el ${longDate(s.enabledAt)}. ` : ''}
              Cada factura que emites lleva el QR de la AEAT y se le envía sola con tu certificado.
            </p>
            {s.pendingCount > 0 && (
              <p className="text-amber-700 dark:text-amber-300">
                {s.pendingCount === 1
                  ? '1 factura aún no consta registrada: '
                  : `${s.pendingCount} facturas aún no constan registradas: `}
                se vuelven a enviar solas cada 15 minutos.
              </p>
            )}
            {s.rejectedCount > 0 && (
              <p className="text-destructive">
                {s.rejectedCount === 1
                  ? 'La AEAT ha rechazado 1 factura. '
                  : `La AEAT ha rechazado ${s.rejectedCount} facturas. `}
                Revísalas en{' '}
                <Link href="/invoices" className="underline">
                  Facturas
                </Link>
                .
              </p>
            )}
            {locked ? (
              <p className="text-muted-foreground">
                No se puede desactivar hasta el {longDate(s.lockedUntil!)}: quien envía sus facturas
                a la AEAT tiene que hacerlo todo el año (art. 17 de la Orden HAC/1177/2024).
              </p>
            ) : (
              canConfigure && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => void change(false)}
                >
                  Desactivar
                </Button>
              )
            )}
          </>
        ) : (
          <>
            <p>
              Tus facturas se emiten sin el QR de la AEAT y no se le envían. Es obligatorio desde el{' '}
              {longDate(VERIFACTU_MANDATORY_FROM.companies)} para las sociedades y desde el{' '}
              {longDate(VERIFACTU_MANDATORY_FROM.others)} para los demás (autónomos, comunidades de
              bienes…). Puedes activarlo antes.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                Desde que lo actives, cada factura llevará el QR y la frase «VERI*FACTU» y se
                enviará sola a la AEAT con tu certificado.
              </li>
              <li>
                La primera factura que emitas abre tu registro en la AEAT: las anteriores no se
                envían.
              </li>
              <li>No se puede desactivar hasta el 31 de diciembre de ese año.</li>
            </ul>
            {s.blockers.length > 0 && (
              <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">Antes de activarlo:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {s.blockers.map((b) => (
                    <li key={b.code}>
                      {b.message}
                      {b.href && (
                        <>
                          {' '}
                          <Link href={b.href} className="underline">
                            Ir
                          </Link>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canConfigure ? (
              <Button
                size="sm"
                disabled={update.isPending || s.blockers.length > 0}
                onClick={() => void change(true)}
              >
                {update.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 size-4" />
                )}
                Activar Veri*Factu
              </Button>
            ) : (
              <p className="text-muted-foreground">Solo el propietario puede activarlo.</p>
            )}
          </>
        )}
        {s.invoicingInHolded && (
          <p className="text-muted-foreground">
            Emites tus facturas en Holded, que se encarga de enviarlas a la AEAT. Este ajuste solo
            cuenta para las que se emiten aquí (por ejemplo, las de tus propietarios).
          </p>
        )}
        {s.platformMode === 'stub' && (
          <p className="text-muted-foreground">
            La plataforma está en modo de pruebas: el envío es simulado y no llega a la AEAT.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
