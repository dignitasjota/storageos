'use client';

import { toast } from 'sonner';

import { RedsysSettingsForm } from '@/components/payments/redsys-settings-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useRedsysSettings, useUpdateRedsysSettings } from '@/lib/payments/redsys';

export function RedsysCard() {
  const settings = useRedsysSettings();
  const update = useUpdateRedsysSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pago con tarjeta — Redsys (TPV bancario)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Permite a los inquilinos pagar sus facturas con tarjeta o Bizum en la pasarela de tu
          banco. Copia los datos de tu TPV virtual (te los da el banco).
        </p>
        {settings.data ? (
          <RedsysSettingsForm
            data={settings.data}
            saving={update.isPending}
            onSave={async (input) => {
              try {
                await update.mutateAsync(input);
                toast.success('Redsys guardado.');
                return true;
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
                return false;
              }
            }}
            cardOnFileHint="El inquilino puede guardar su tarjeta al pagar y las siguientes cuotas se cobran solas. Actívalo solo si tu banco ha habilitado el «pago por referencia» (COF) en tu TPV; si no, los cobros automáticos fallarán. Para que se cobre al emitir cada factura, activa también el cobro automático."
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
