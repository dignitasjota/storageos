'use client';

import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useSetCustomerMarketing } from '@/lib/customers/hooks';

/**
 * Comunicaciones comerciales (campañas, win-back). Un cliente las recibe
 * mientras no se dé de baja: desde el enlace del correo o a petición suya.
 */
export function MarketingPreferenceCard({
  customerId,
  optOutAt,
}: {
  customerId: string;
  optOutAt: string | null;
}) {
  const set = useSetCustomerMarketing();

  async function toggle() {
    const subscribed = !!optOutAt;
    if (
      subscribed &&
      !window.confirm('Vuelve a darle de alta solo si el cliente te lo ha pedido. ¿Continuar?')
    ) {
      return;
    }
    try {
      await set.mutateAsync({ id: customerId, subscribed });
      toast.success(subscribed ? 'Volverá a recibir comunicaciones comerciales.' : 'Dado de baja.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Comunicaciones comerciales</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">
          {optOutAt
            ? `Se dio de baja el ${new Date(optOutAt).toLocaleDateString('es-ES')}: no recibe campañas ni ofertas.`
            : 'Recibe campañas y ofertas. Cada correo comercial lleva un enlace para darse de baja.'}
        </p>
        <Can permission="customers:write">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void toggle()}
            disabled={set.isPending}
          >
            {optOutAt ? 'Volver a dar de alta' : 'Dar de baja'}
          </Button>
        </Can>
      </CardContent>
    </Card>
  );
}
