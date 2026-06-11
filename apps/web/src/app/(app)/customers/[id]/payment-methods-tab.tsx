'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { CreditCard, Landmark, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PaymentMethodDto, SetupIntentResponseDto } from '@storageos/shared';
import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateSetupIntent,
  useCustomerPaymentMethods,
  useRegisterPaymentMethod,
  useRemovePaymentMethod,
} from '@/lib/billing/hooks';

// Cache del cliente Stripe por publishable key (cada tenant puede tener la
// suya en el futuro; hoy es una global del deployment).
const stripeClients = new Map<string, Promise<Stripe | null>>();

function getStripe(publishableKey: string): Promise<Stripe | null> {
  let client = stripeClients.get(publishableKey);
  if (!client) {
    client = loadStripe(publishableKey);
    stripeClients.set(publishableKey, client);
  }
  return client;
}

export function CustomerPaymentMethodsTab({ customerId }: { customerId: string }) {
  const methods = useCustomerPaymentMethods(customerId);
  const createSetupIntent = useCreateSetupIntent();
  const remove = useRemovePaymentMethod();
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function openAddDialog() {
    try {
      const intent = await createSetupIntent.mutateAsync(customerId);
      setSetupIntent(intent);
      setDialogOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo iniciar el alta.');
    }
  }

  async function handleRemove(pm: PaymentMethodDto) {
    if (!window.confirm(`¿Eliminar el método ${formatLabel(pm)}?`)) return;
    try {
      await remove.mutateAsync({ id: pm.id, customerId });
      toast.success('Método de pago eliminado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo eliminar.');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Métodos de pago</CardTitle>
        <Button onClick={openAddDialog} disabled={createSetupIntent.isPending}>
          {createSetupIntent.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-1 h-4 w-4" />
          )}
          Añadir método de pago
        </Button>
      </CardHeader>
      <CardContent>
        {methods.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !methods.data?.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Sin métodos de pago. Añade un IBAN (SEPA) o una tarjeta para poder cobrar las facturas
            automáticamente.
          </p>
        ) : (
          <ul className="divide-y">
            {methods.data.map((pm) => (
              <li key={pm.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  {pm.type === 'sepa_debit' ? (
                    <Landmark className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <CreditCard className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{formatLabel(pm)}</p>
                    <p className="text-xs text-muted-foreground">
                      {pm.type === 'sepa_debit'
                        ? `Domiciliación SEPA${pm.mandateReference ? ` · mandato ${pm.mandateReference}` : ''}`
                        : pm.expMonth && pm.expYear
                          ? `Caduca ${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}`
                          : 'Tarjeta'}
                    </p>
                  </div>
                  {pm.isDefault && <Badge variant="secondary">Predeterminado</Badge>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleRemove(pm)}
                  disabled={remove.isPending}
                  aria-label="Eliminar método de pago"
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setSetupIntent(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Añadir método de pago</DialogTitle>
            <DialogDescription>
              IBAN (domiciliación SEPA) o tarjeta. Para SEPA, el cliente debe haber aceptado el
              mandato de domiciliación (firmado en el contrato o por escrito).
            </DialogDescription>
          </DialogHeader>
          {setupIntent && (
            <Elements
              stripe={getStripe(setupIntent.publishableKey)}
              options={{ clientSecret: setupIntent.clientSecret, locale: 'es' }}
            >
              <AddPaymentMethodForm
                customerId={customerId}
                gatewayCustomerId={setupIntent.customerId}
                onDone={() => {
                  setDialogOpen(false);
                  setSetupIntent(null);
                }}
              />
            </Elements>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Formulario interno del dialog. Vive en un componente aparte porque
 * `useStripe()` / `useElements()` solo funcionan dentro de `<Elements>`.
 * `<PaymentElement>` renderiza tarjeta + IBAN SEPA (con el texto legal del
 * mandato) según los `payment_method_types` del SetupIntent del backend.
 */
function AddPaymentMethodForm({
  customerId,
  gatewayCustomerId,
  onDone,
}: {
  customerId: string;
  gatewayCustomerId: string;
  onDone: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const register = useRegisterPaymentMethod();
  const [isDefault, setIsDefault] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    try {
      const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (result.error) {
        toast.error(result.error.message ?? 'No se pudo confirmar el método de pago.');
        return;
      }
      const pm = result.setupIntent.payment_method;
      const gatewayToken = typeof pm === 'string' ? pm : (pm?.id ?? null);
      if (!gatewayToken) {
        toast.error('Stripe no devolvió el método de pago.');
        return;
      }
      // `type` es solo fallback: el backend deriva el tipo real (card /
      // sepa_debit) consultando el payment method en Stripe.
      await register.mutateAsync({
        customerId,
        type: 'card',
        gatewayToken,
        gatewayCustomerId,
        isDefault,
      });
      toast.success('Método de pago guardado.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <PaymentElement />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
        Usar como método de pago predeterminado
      </label>
      <Button type="submit" className="w-full" disabled={!stripe || submitting}>
        {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        Guardar método de pago
      </Button>
    </form>
  );
}

function formatLabel(pm: PaymentMethodDto): string {
  if (pm.type === 'sepa_debit') {
    return `IBAN •••• ${pm.last4 ?? '????'}`;
  }
  const brand = pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : 'Tarjeta';
  return `${brand} •••• ${pm.last4 ?? '????'}`;
}
