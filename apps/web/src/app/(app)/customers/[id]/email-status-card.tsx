'use client';

import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useClearCustomerEmailBlock, useCustomerEmailStatus } from '@/lib/customers/hooks';

/**
 * Aviso cuando el email del inquilino está en la lista de supresión: rebota de
 * forma permanente (no se le envía nada) o marcó un correo como spam (no recibe
 * campañas). Solo se muestra si hay algún bloqueo.
 */
export function EmailStatusCard({ customerId }: { customerId: string }) {
  const { data } = useCustomerEmailStatus(customerId);
  const clear = useClearCustomerEmailBlock();
  if (!data || data.length === 0) return null;
  const hard = data.find((s) => s.scope === 'all');

  async function onClear() {
    if (
      !window.confirm(
        'Desbloquéalo solo si el inquilino te confirma que su buzón funciona. Si vuelve a rebotar, se bloqueará otra vez.',
      )
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

  return (
    <Card className="mt-4 border-amber-300 dark:border-amber-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Problema con su email
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="space-y-1 text-muted-foreground">
          {hard ? (
            <p>
              {hard.reasonLabel} desde el {new Date(hard.createdAt).toLocaleDateString('es-ES')}: no
              se le envía ningún correo (facturas, avisos ni accesos). Pídele otro email o
              compruébalo con él.
            </p>
          ) : (
            <p>
              Marcó como spam un correo vuestro: ya no recibe campañas ni ofertas. Los correos de su
              contrato siguen saliendo.
            </p>
          )}
          {hard?.detail && <p className="text-xs">{hard.detail}</p>}
        </div>
        {hard && (
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
        )}
      </CardContent>
    </Card>
  );
}
