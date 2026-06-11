'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type * as React from 'react';

import { Button } from '@/components/ui/button';

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

interface StripeSetupFormProps {
  clientSecret: string;
  publishableKey: string;
  submitLabel?: string;
  /**
   * Recibe el `payment_method` id (gatewayToken) tras confirmar el
   * SetupIntent; debe registrarlo en el backend. Si lanza, el form vuelve
   * a quedar editable.
   */
  onConfirmed: (gatewayToken: string) => Promise<void>;
  /** Campos extra entre el PaymentElement y el botón (p.ej. checkbox). */
  children?: React.ReactNode;
}

/**
 * Formulario de alta de método de pago con Stripe `<PaymentElement>`:
 * renderiza tarjeta + IBAN SEPA (con el texto legal del mandato) según los
 * `payment_method_types` del SetupIntent creado por el backend. Usado por
 * la pestaña Pagos del panel staff y por el portal del inquilino.
 */
export function StripeSetupForm({
  clientSecret,
  publishableKey,
  submitLabel = 'Guardar método de pago',
  onConfirmed,
  children,
}: StripeSetupFormProps) {
  return (
    <Elements stripe={getStripe(publishableKey)} options={{ clientSecret, locale: 'es' }}>
      <InnerSetupForm submitLabel={submitLabel} onConfirmed={onConfirmed}>
        {children}
      </InnerSetupForm>
    </Elements>
  );
}

/**
 * Separado porque `useStripe()` / `useElements()` solo funcionan dentro
 * de `<Elements>`.
 */
function InnerSetupForm({
  submitLabel,
  onConfirmed,
  children,
}: Pick<StripeSetupFormProps, 'onConfirmed' | 'children'> & { submitLabel: string }) {
  const stripe = useStripe();
  const elements = useElements();
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
      await onConfirmed(gatewayToken);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <PaymentElement />
      {children}
      <Button type="submit" className="w-full" disabled={!stripe || submitting}>
        {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
