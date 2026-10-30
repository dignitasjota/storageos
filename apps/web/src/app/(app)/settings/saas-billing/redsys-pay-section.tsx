'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { RedsysPayMethod } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatEur } from '@/lib/format';
import { submitRedsysForm } from '@/lib/payments/redsys';
import {
  fetchSaasRedsysRedirect,
  useDisableSaasRedsysAutoCharge,
  useSaasRedsysOptions,
} from '@/lib/saas-billing/hooks';

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  diners: 'Diners',
  jcb: 'JCB',
};

/**
 * Pagar la suscripción con tarjeta o Bizum en el TPV de TrasterOS y, si el
 * banco lo permite, guardar la tarjeta para que se cobre sola cada mes.
 */
export function RedsysPaySection() {
  const options = useSaasRedsysOptions();
  const disable = useDisableSaasRedsysAutoCharge();
  const ask = useConfirm();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<RedsysPayMethod | null>(null);
  const [saveCard, setSaveCard] = useState(true);
  // Si debe varios meses, por defecto los paga todos de una vez.
  const [months, setMonths] = useState<number | null>(null);

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
      const keepCard = method === 'card' && o!.cardOnFileAvailable && saveCard;
      submitRedsysForm(await fetchSaasRedsysRedirect(method, keepCard, payMonths));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir el pago');
      setBusy(null);
    }
  }

  const owed = Math.min(12, Math.max(1, o.monthsOwed));
  const payMonths = Math.min(12, months ?? owed);
  const card = o.savedCard;
  const cardName = card
    ? `${card.brand ? (BRANDS[card.brand] ?? card.brand) : 'Tarjeta'}${card.last4 ? ` ···· ${card.last4}` : ''}`
    : '';
  const cardExpiry =
    card?.expMonth && card.expYear
      ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`
      : null;

  return (
    <Card className={o.pastDue ? 'border-destructive/50' : undefined}>
      <CardHeader>
        <CardTitle className="text-base">
          {o.autoCharge ? 'Cobro automático con tarjeta' : 'Pagar con tarjeta o Bizum'}
        </CardTitle>
        <CardDescription>
          {o.pastDue
            ? 'Tienes un pago pendiente. Págalo ahora y tu cuenta vuelve a estar al día.'
            : o.autoCharge
              ? 'Tu suscripción se cobra sola cada mes con tu tarjeta guardada.'
              : 'Paga el siguiente mes de tu suscripción cuando quieras.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {o.autoCharge && card ? (
          <div className="rounded-md border p-3">
            <p className="font-medium">
              {cardName}
              {cardExpiry ? (
                <span className="font-normal text-muted-foreground"> · caduca {cardExpiry}</span>
              ) : null}
            </p>
            <p className="text-muted-foreground">
              Próximo cobro: {formatEur(o.amount)}
              {o.currentPeriodEnd ? ` el ${formatDate(o.currentPeriodEnd)}` : ''}.
            </p>
            {card.lastError ? (
              <p className="mt-1 text-destructive">
                El último cobro no se pudo hacer: {card.lastError}. Paga ahora con otra tarjeta.
              </p>
            ) : null}
          </div>
        ) : (
          <p>
            <span className="font-medium">{formatEur(o.amount)}</span> (IVA incluido) · un mes del
            plan {o.planName}
            {o.currentPeriodEnd ? ` desde el ${formatDate(o.currentPeriodEnd)}` : ''}.
          </p>
        )}

        {owed > 1 || payMonths > 1 ? (
          <div className="space-y-1">
            {owed > 1 ? (
              <p className="text-destructive">
                Debes {owed} meses ({formatEur(o.amount * owed)}).
              </p>
            ) : null}
            <label className="flex flex-wrap items-center gap-2">
              Pagar
              <select
                className="h-9 rounded-md border bg-background px-2 text-base sm:text-sm"
                value={payMonths}
                onChange={(e) => setMonths(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(owed, 3) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 mes' : `${n} meses`} · {formatEur(o.amount * n)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {o.cardOnFileAvailable ? (
          <label className="flex items-start gap-2">
            <Checkbox
              checked={saveCard}
              onCheckedChange={(v) => setSaveCard(v === true)}
              className="mt-0.5"
            />
            <span>
              {o.autoCharge
                ? 'Guardar la tarjeta con la que pague ahora para los próximos cobros'
                : 'Guardar la tarjeta y cobrar automáticamente cada mes'}
              <span className="block text-xs text-muted-foreground">
                Solo con tarjeta. Puedes desactivarlo cuando quieras.
              </span>
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {o.cardEnabled ? (
            <Button
              variant={o.autoCharge && !o.pastDue ? 'outline' : 'default'}
              onClick={() => void pay('card')}
              disabled={busy !== null}
            >
              {busy === 'card' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              {o.autoCharge ? 'Pagar ahora con otra tarjeta' : 'Pagar con tarjeta'}
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
          {o.autoCharge ? (
            <Button
              variant="ghost"
              disabled={disable.isPending}
              onClick={async () => {
                const ok = await ask({
                  title: 'Desactivar el cobro automático',
                  description:
                    'Se borra la tarjeta guardada y tendrás que pagar cada mes desde aquí o por transferencia.',
                  confirmLabel: 'Desactivar',
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await disable.mutateAsync();
                  toast.success('Cobro automático desactivado.');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo desactivar');
                }
              }}
            >
              Desactivar el cobro automático
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
