'use client';

import { GoCardlessCard } from '../billing/gocardless-card';
import { RedsysCard } from '../billing/redsys-card';

import {
  AutoChargeCard,
  AutoChargeRetryCard,
  SepaSettingsCard,
  TransferIbanCard,
} from './payment-cards';

/** Cómo cobras a tus inquilinos: automático, reintentos, transferencia, TPV y domiciliación. */
export default function PaymentsSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cobros</h1>
        <p className="text-sm text-muted-foreground">
          Cómo cobras a tus inquilinos: cobro automático al emitir, reintentos, transferencia, pago
          con tarjeta o Bizum (Redsys) y domiciliación (GoCardless o remesas SEPA de tu banco).
        </p>
      </div>
      <AutoChargeCard />
      <AutoChargeRetryCard />
      <TransferIbanCard />
      <RedsysCard />
      <GoCardlessCard />
      <SepaSettingsCard />
    </div>
  );
}
