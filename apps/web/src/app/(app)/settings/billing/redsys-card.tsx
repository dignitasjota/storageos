'use client';

import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { RedsysSettingsForm } from '@/components/payments/redsys-settings-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import {
  useRedsysSettings,
  useTestRedsysSettings,
  useUpdateRedsysSettings,
} from '@/lib/payments/redsys';
import { savedMethodsWarning, useSavedMethodsSummary } from '@/lib/payments/saved-methods';

export function RedsysCard() {
  const settings = useRedsysSettings();
  const update = useUpdateRedsysSettings();
  const test = useTestRedsysSettings();
  const confirm = useConfirm();
  const saved = useSavedMethodsSummary();

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
            onTest={async (input) => {
              try {
                return await test.mutateAsync(input);
              } catch (err) {
                toast.error(
                  err instanceof ApiError ? err.body.message : 'No se pudo probar el TPV.',
                );
                return null;
              }
            }}
            onSave={async (input) => {
              // Apagar Redsys o el pago por referencia deja sin cobrar las tarjetas guardadas.
              const current = settings.data;
              const turningOff =
                !!current &&
                ((current.enabled && !input.enabled) ||
                  (current.cardOnFileEnabled && input.enabled && !input.cardOnFileEnabled));
              const warning = turningOff
                ? savedMethodsWarning(
                    saved.data?.redsys,
                    {
                      saved: ['tarjeta guardada', 'tarjetas guardadas'],
                      charge: 'cobrarse solas con su tarjeta',
                      reversible: true,
                    },
                    saved.data?.autoChargeOnIssue ?? false,
                  )
                : null;
              if (warning) {
                const ok = await confirm({
                  title:
                    current?.enabled && !input.enabled
                      ? 'Desactivar el pago por Redsys'
                      : 'Desactivar el pago por referencia',
                  description: warning,
                  confirmLabel: 'Desactivar',
                  destructive: true,
                });
                if (!ok) return false;
              }
              try {
                await update.mutateAsync(input);
                void saved.refetch();
                toast.success('Redsys guardado.');
                return true;
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
                return false;
              }
            }}
            cardOnFileHint="El inquilino puede guardar su tarjeta al pagar y las siguientes cuotas se cobran solas. Actívalo solo si tu banco ha habilitado el «pago por referencia» (COF) en tu TPV; si no, los cobros automáticos fallarán. Para que se cobre al emitir cada factura, activa también el cobro automático."
          />
        ) : settings.isError ? (
          <SectionError onRetry={() => void settings.refetch()} />
        ) : null}
      </CardContent>
    </Card>
  );
}
