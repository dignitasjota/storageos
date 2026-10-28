'use client';

import { Suspense } from 'react';

import { GoCardlessCard } from '../billing/gocardless-card';
import { RedsysCard } from '../billing/redsys-card';

import {
  AutoChargeCard,
  AutoChargeRetryCard,
  OfflinePaymentOptionsCard,
  SepaSettingsCard,
  TransferIbanCard,
} from './payment-cards';
import { StripeConnectCard } from './stripe-connect-card';

/** Cómo cobras a tus inquilinos: automático, reintentos, transferencia, TPV y domiciliación. */
export default function PaymentsSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cobros</h1>
        <p className="text-sm text-muted-foreground">
          Cómo cobras a tus inquilinos: cobro automático al emitir, reintentos, transferencia, pago
          con tarjeta (Redsys o tu cuenta de Stripe), Bizum y domiciliación (GoCardless o remesas
          SEPA de tu banco).
        </p>
      </div>
      <AutoChargeCard />
      <AutoChargeRetryCard />
      <TransferIbanCard />
      <OfflinePaymentOptionsCard />
      <Suspense fallback={null}>
        <StripeConnectCard />
      </Suspense>
      <RedsysCard />
      <GoCardlessCard />
      <SepaSettingsCard />
    </div>
  );
}
