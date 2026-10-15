'use client';

import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import type { CardProvider } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useDisconnectStripe,
  useRefreshStripeConnect,
  useSetCardProvider,
  useStripeConnect,
  useStripeConnectDashboard,
  useStripeConnectOnboarding,
} from '@/lib/payments/stripe-connect';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo completar la operación';
}

/**
 * Cobro con tarjeta a los inquilinos: con Redsys (TPV del banco) o con la cuenta
 * de Stripe del propio tenant (Stripe Connect).
 */
export function StripeConnectCard() {
  const status = useStripeConnect();
  const onboarding = useStripeConnectOnboarding();
  const dashboard = useStripeConnectDashboard();
  const refresh = useRefreshStripeConnect();
  const disconnect = useDisconnectStripe();
  const setProvider = useSetCardProvider();
  const params = useSearchParams();
  const refreshedOnReturn = useRef(false);

  const s = status.data;

  // Al volver del registro de Stripe se lee el estado de la cuenta.
  useEffect(() => {
    if (refreshedOnReturn.current || !s?.connected) return;
    const flag = params.get('stripe');
    if (flag !== 'return' && flag !== 'refresh') return;
    refreshedOnReturn.current = true;
    refresh.mutate(undefined, {
      onSuccess: (d) =>
        d.chargesEnabled
          ? toast.success('Tu cuenta de Stripe ya puede cobrar.')
          : toast.message('Stripe aún necesita algunos datos para activar la cuenta.'),
    });
  }, [params, s?.connected, refresh]);

  async function connect() {
    try {
      const { url } = await onboarding.mutateAsync();
      window.location.href = url;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function openDashboard() {
    try {
      const { url } = await dashboard.mutateAsync();
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function chooseProvider(value: string) {
    const provider = value === 'auto' ? null : (value as CardProvider);
    try {
      await setProvider.mutateAsync(provider);
      toast.success('Guardado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function doDisconnect() {
    if (
      !window.confirm(
        'Se desconecta la cuenta de Stripe de la app (sigue existiendo en Stripe). Los inquilinos dejarán de poder pagar con tarjeta por Stripe. ¿Continuar?',
      )
    )
      return;
    try {
      await disconnect.mutateAsync();
      toast.success('Cuenta de Stripe desconectada.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (!s) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          Cargando…
        </CardContent>
      </Card>
    );
  }

  const effective =
    s.effectiveCardProvider === 'stripe'
      ? 'Stripe'
      : s.effectiveCardProvider === 'redsys'
        ? 'Redsys'
        : 'ninguno';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cobro con tarjeta a los inquilinos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Elige con qué cobras las tarjetas: con el TPV de tu banco (Redsys) o con tu propia cuenta
          de Stripe. El dinero llega a tu cuenta. Ahora mismo se cobra con:{' '}
          <span className="font-medium text-foreground">{effective}</span>.
        </p>

        <div className="space-y-1">
          <p className="text-sm font-medium">Proveedor de la tarjeta</p>
          <Can permission="billing:configure" fallback={<p className="text-sm">{effective}</p>}>
            <Select
              value={s.cardProvider ?? 'auto'}
              onValueChange={(v) => void chooseProvider(v)}
              disabled={setProvider.isPending}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automático (Redsys si está activo)</SelectItem>
                <SelectItem value="redsys" disabled={!s.redsysEnabled}>
                  Redsys{s.redsysEnabled ? '' : ' (no activado)'}
                </SelectItem>
                <SelectItem value="stripe" disabled={!s.chargesEnabled}>
                  Stripe{s.chargesEnabled ? '' : ' (conecta tu cuenta)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </Can>
        </div>

        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">Tu cuenta de Stripe</p>
            {!s.connected ? (
              <Badge variant="outline">Sin conectar</Badge>
            ) : s.chargesEnabled ? (
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Lista para cobrar
              </Badge>
            ) : (
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Registro pendiente
              </Badge>
            )}
          </div>

          {!s.platformAvailable ? (
            <p className="text-sm text-muted-foreground">
              Los cobros con Stripe aún no están disponibles en la plataforma.
            </p>
          ) : !s.connected ? (
            <p className="text-sm text-muted-foreground">
              Abre tu cuenta de Stripe en unos minutos, sin pedir un TPV al banco. Los inquilinos
              podrán guardar su tarjeta y pagar cada mes de forma automática. Stripe cobra su tarifa
              por cada pago y la plataforma una comisión del{' '}
              {s.applicationFeePct.toLocaleString('es-ES')}
              %.
            </p>
          ) : (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Cuenta {s.accountId}</p>
              <p>
                Comisión de la plataforma: {s.applicationFeePct.toLocaleString('es-ES')} % por cobro
                (además de la tarifa de Stripe).
              </p>
              {!s.chargesEnabled && s.requirementsDue.length > 0 ? (
                <p className="text-amber-700 dark:text-amber-300">
                  Stripe aún necesita algunos datos. Continúa el registro para activarla.
                </p>
              ) : null}
            </div>
          )}

          <Can permission="billing:configure">
            <div className="flex flex-wrap gap-2">
              {s.platformAvailable && !s.chargesEnabled ? (
                <Button onClick={() => void connect()} disabled={onboarding.isPending}>
                  {onboarding.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {s.connected ? 'Continuar el registro en Stripe' : 'Conectar Stripe'}
                </Button>
              ) : null}
              {s.connected ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    refresh.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })
                  }
                  disabled={refresh.isPending}
                >
                  Comprobar estado
                </Button>
              ) : null}
              {s.detailsSubmitted ? (
                <Button
                  variant="outline"
                  onClick={() => void openDashboard()}
                  disabled={dashboard.isPending}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Abrir mi panel de Stripe
                </Button>
              ) : null}
              {s.connected ? (
                <Button
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void doDisconnect()}
                  disabled={disconnect.isPending}
                >
                  Desconectar
                </Button>
              ) : null}
            </div>
          </Can>
        </div>
      </CardContent>
    </Card>
  );
}
