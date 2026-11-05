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

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PAYMENT_GUIDE = [
  {
    href: '#transferencia',
    title: 'Lo más rápido',
    text: 'Transferencia a tu IBAN o pago en el local. Sin contratar nada; en dos minutos.',
  },
  {
    href: '#tarjeta',
    title: 'Tarjeta y Bizum',
    text: 'Redsys, si tu banco te da un TPV virtual, o tu propia cuenta de Stripe.',
  },
  {
    href: '#domiciliacion',
    title: 'Domiciliación',
    text: 'Remesas SEPA con tu banco o GoCardless, para cobrar sin que el inquilino haga nada.',
  },
];

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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">¿Por dónde empiezo?</CardTitle>
          <CardDescription>
            Con una forma de cobro ya puedes operar; el resto lo añades cuando quieras.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          {PAYMENT_GUIDE.map((g) => (
            <a
              key={g.href}
              href={g.href}
              className="rounded-md border p-3 text-sm transition-colors hover:bg-accent"
            >
              <span className="font-medium">{g.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{g.text}</span>
            </a>
          ))}
        </CardContent>
      </Card>
      <div id="transferencia" className="scroll-mt-20 space-y-6">
        <TransferIbanCard />
        <OfflinePaymentOptionsCard />
      </div>
      <div id="tarjeta" className="scroll-mt-20 space-y-6">
        <Suspense fallback={null}>
          <StripeConnectCard />
        </Suspense>
        <RedsysCard />
      </div>
      <div id="domiciliacion" className="scroll-mt-20 space-y-6">
        <GoCardlessCard />
        <SepaSettingsCard />
      </div>
      <div id="automatico" className="scroll-mt-20 space-y-6">
        <AutoChargeCard />
        <AutoChargeRetryCard />
      </div>
    </div>
  );
}
