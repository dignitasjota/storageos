'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { RedsysPayMethod } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatEur } from '@/lib/format';
import { submitRedsysForm } from '@/lib/payments/redsys';
import { fetchSaasRedsysRedirect, useSaasRedsysOptions } from '@/lib/saas-billing/hooks';

/**
 * Pagar la suscripción con tarjeta o Bizum en el TPV de TrasterOS. Solo si se
 * paga a mano (sin Stripe ni domiciliación) y el TPV está activo.
 */
export function RedsysPaySection() {
  const options = useSaasRedsysOptions();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<RedsysPayMethod | null>(null);

  // Vuelta del TPV: Redsys avisa al servidor por su cuenta; puede tardar unos segundos.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('redsys');
    if (!result) return;
    if (result === 'ok') {
      toast.success('Pago recibido. Puede tardar unos segundos en aparecer.');
      const refresh = () => void qc.invalidateQueries({ queryKey: ['saas-billing'] });
      const timers = [2000, 6000, 15000].map((ms) => window.setTimeout(refresh, ms));
      window.history.replaceState(null, '', window.location.pathname);
      return () => timers.forEach((t) => window.clearTimeout(t));
    }
    toast.error('El pago no se ha completado. No se te ha cobrado nada.');
    window.history.replaceState(null, '', window.location.pathname);
    return undefined;
  }, [qc]);

  const o = options.data;
  if (!o?.available) return null;

  async function pay(method: RedsysPayMethod) {
    setBusy(method);
    try {
      submitRedsysForm(await fetchSaasRedsysRedirect(method));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir el pago');
      setBusy(null);
    }
  }

  return (
    <Card className={o.pastDue ? 'border-destructive/50' : undefined}>
      <CardHeader>
        <CardTitle className="text-base">Pagar con tarjeta o Bizum</CardTitle>
        <CardDescription>
          {o.pastDue
            ? 'Tienes un pago pendiente. Págalo ahora y tu cuenta vuelve a estar al día.'
            : 'Paga el siguiente mes de tu suscripción cuando quieras.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          <span className="font-medium">{formatEur(o.amount)}</span> (IVA incluido) · un mes del
          plan {o.planName}
          {o.currentPeriodEnd ? ` desde el ${formatDate(o.currentPeriodEnd)}` : ''}.
        </p>
        <div className="flex flex-wrap gap-2">
          {o.cardEnabled ? (
            <Button onClick={() => void pay('card')} disabled={busy !== null}>
              {busy === 'card' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              Pagar con tarjeta
            </Button>
          ) : null}
          {o.bizumEnabled ? (
            <Button variant="outline" onClick={() => void pay('bizum')} disabled={busy !== null}>
              {busy === 'bizum' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Smartphone className="mr-2 h-4 w-4" />
              )}
              Pagar con Bizum
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Se abre la pasarela segura del banco. La factura te llega por correo y queda en «Facturas
          y pagos».
        </p>
      </CardContent>
    </Card>
  );
}
