'use client';

import { toast } from 'sonner';

import { RedsysSettingsForm } from '@/components/payments/redsys-settings-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminPlatformRedsysSettings, useUpdatePlatformRedsysSettings } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

export default function PlatformRedsysPage() {
  const canEdit = useIsSuperadmin();
  const settings = useAdminPlatformRedsysSettings();
  const update = useUpdatePlatformRedsysSettings();

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">TPV Redsys</h1>
        <p className="text-sm text-muted-foreground">
          Tu TPV virtual para que los tenants paguen la suscripción con tarjeta o Bizum.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Datos del TPV virtual</CardTitle>
          <CardDescription>
            Te los da el banco al contratar el TPV (código de comercio, terminal y clave SHA-256 del
            panel de Redsys). Sirven para cualquier banco que use Redsys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings.data ? (
            <RedsysSettingsForm
              data={settings.data}
              readOnly={!canEdit}
              cardOnFileHint="El tenant puede guardar su tarjeta al pagar y la suscripción se cobra sola cada mes (hasta 3 intentos si la rechaza el banco). Actívalo solo si tu banco ha habilitado el «pago por referencia» (COF) en el TPV."
              saving={update.isPending}
              onSave={async (input) => {
                try {
                  await update.mutateAsync(input);
                  toast.success('TPV guardado.');
                  return true;
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
                  return false;
                }
              }}
            />
          ) : null}
          {!canEdit ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Solo un super admin puede cambiar el TPV.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cómo funciona</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Los tenants que pagan a mano (sin Stripe ni domiciliación SEPA) ven en Ajustes →
            Suscripción «Pagar con tarjeta» y, si lo activas, «Pagar con Bizum». Cada pago cubre un
            mes del plan: extiende el periodo, emite la factura y, si había impago, la cuenta vuelve
            a estar al día.
          </p>
          <p>
            Con el pago por referencia activo pueden marcar «Guardar la tarjeta y cobrar cada mes»:
            la suscripción pasa a «Tarjeta (Redsys)» y se cobra sola el día que vence (06:00). Si el
            banco la rechaza se reintenta a los 2 días, hasta 3 veces; después te llega un aviso y
            el tenant queda con el pago pendiente.
          </p>
          <p>
            En el TPV la notificación online debe estar en «HTTP» (síncrona). La dirección de aviso
            la manda la aplicación en cada pago: no hace falta configurarla en el banco.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
