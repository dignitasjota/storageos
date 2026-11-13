'use client';

import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import {
  useClearCustomerEmailBlock,
  useCustomerEmailStatus,
  useUpdateCustomer,
} from '@/lib/customers/hooks';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * «Problema con su email» en la ficha del inquilino. Sale si su email está
 * bloqueado (rebote permanente o marcó un correo como spam), si su último
 * correo no le llegó o si el dominio parece mal escrito (`@gmial.com`), con un
 * botón para corregirlo.
 */
export function EmailStatusCard({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const { data } = useCustomerEmailStatus(customerId);
  const clear = useClearCustomerEmailBlock();
  const update = useUpdateCustomer();
  if (!data) return null;
  const hard = data.suppressions.find((s) => s.scope === 'all');
  const complaint = data.suppressions.find((s) => s.scope === 'marketing');
  const undelivered = hard ? null : data.undelivered;
  const suggestion = data.suggestion;
  if (!hard && !complaint && !undelivered && !suggestion) return null;

  async function onClear() {
    if (
      !(await ask({
        title: '¿Seguro?',
        description:
          'Desbloquéalo solo si el inquilino te confirma que su buzón funciona. Si vuelve a rebotar, se bloqueará otra vez.',
      }))
    ) {
      return;
    }
    try {
      await clear.mutateAsync(customerId);
      toast.success('Email desbloqueado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo desbloquear.');
    }
  }

  async function onFix(email: string) {
    if (
      !(await ask({
        title: `¿Cambiar su email a ${email}?`,
        description:
          'Los correos siguientes irán a la dirección nueva. Lo que ya se envió (un enlace de firma, una factura…) tendrás que reenviarlo.',
        confirmLabel: 'Cambiar',
      }))
    ) {
      return;
    }
    try {
      await update.mutateAsync({ id: customerId, input: { email } });
      toast.success('Email cambiado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar el email.');
    }
  }

  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Problema con su email
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {hard && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 text-muted-foreground">
              <p>
                {hard.reasonLabel} desde el {formatDate(hard.createdAt)}: no se le envía ningún
                correo (facturas, avisos ni accesos). Pídele otro email o compruébalo con él.
              </p>
              {hard.detail && <p className="text-xs">{hard.detail}</p>}
            </div>
            <Can permission="customers:write">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onClear()}
                disabled={clear.isPending}
              >
                Desbloquear
              </Button>
            </Can>
          </div>
        )}
        {undelivered && (
          <div className="space-y-1 text-muted-foreground">
            <p>
              Su último correo{undelivered.subject ? ` («${undelivered.subject}»)` : ''} no le ha
              llegado ({formatDateTime(undelivered.at)}).
              {undelivered.temporary
                ? ' El servidor de su correo lo rechaza de momento; se sigue intentando unas horas.'
                : ''}
            </p>
            {undelivered.reason && <p className="text-xs">{undelivered.reason}</p>}
          </div>
        )}
        {complaint && !hard && (
          <p className="text-muted-foreground">
            Marcó como spam un correo vuestro: ya no recibe campañas ni ofertas. Los correos de su
            contrato siguen saliendo.
          </p>
        )}
        {suggestion && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
            <p>
              ¿Está bien escrito? <span className="break-words">{data.email}</span> parece que
              debería ser <strong className="break-words">{suggestion}</strong>.
            </p>
            <Can permission="customers:write">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onFix(suggestion)}
                disabled={update.isPending}
              >
                Cambiar el email
              </Button>
            </Can>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
