'use client';

import { CreditCard, FlaskConical, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PortalDemoCardPaymentResultDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/auth/api';

const TEXT = {
  es: {
    open: 'Pagar con tarjeta',
    notice:
      'Demostración: el pago es simulado. No se cobra nada ni se envía ningún dato a un banco o pasarela.',
    card: 'Tarjeta de prueba',
    expiry: 'Caduca',
    pay: (amount: string) => `Pagar ${amount}`,
    cancel: 'Cancelar',
    done: 'Pago simulado completado.',
    error: 'No se ha podido completar el pago simulado.',
  },
  en: {
    open: 'Pay by card',
    notice:
      'Demo: this payment is simulated. Nothing is charged and no data is sent to any bank or payment gateway.',
    card: 'Test card',
    expiry: 'Expires',
    pay: (amount: string) => `Pay ${amount}`,
    cancel: 'Cancel',
    done: 'Simulated payment completed.',
    error: 'The simulated payment could not be completed.',
  },
} as const;

/**
 * Pago con tarjeta SIMULADO de la cuenta de demostración. Enseña un formulario
 * de tarjeta de prueba que no lleva a ninguna pasarela: al pagar, el servidor
 * apunta el cobro dentro de la demo (y solo en la demo; en otro negocio da 403).
 */
export function DemoCardPayment({
  invoiceId,
  portalToken,
  amountLabel,
  locale,
  onPaid,
  size = 'default',
}: {
  invoiceId: string;
  portalToken: string;
  amountLabel: string;
  locale: string;
  onPaid: () => void;
  size?: 'default' | 'sm';
}) {
  const t = locale.startsWith('en') ? TEXT.en : TEXT.es;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    try {
      await apiFetch<PortalDemoCardPaymentResultDto>(
        `/portal/me/invoices/${invoiceId}/demo-card-payment`,
        {
          method: 'POST',
          requiresAuth: false,
          headers: { Authorization: `Bearer ${portalToken}` },
        },
      );
      toast.success(t.done);
      setOpen(false);
      onPaid();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t.error);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size={size} onClick={() => setOpen(true)}>
        <CreditCard className="mr-1.5 h-4 w-4" />
        {t.open}
      </Button>
    );
  }

  return (
    <div className="w-full space-y-3 rounded-md border bg-background p-3">
      <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
        {t.notice}
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-sm">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t.card}</span>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono tabular-nums">
            4242 4242 4242 4242
          </div>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t.expiry}</span>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono tabular-nums">
            12/30
          </div>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">CVC</span>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono tabular-nums">123</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size={size} onClick={() => void pay()} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {t.pay(amountLabel)}
        </Button>
        <Button size={size} variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
