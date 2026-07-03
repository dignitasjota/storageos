'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

import { useBillingStatus } from '@/lib/auth/hooks';

/**
 * Banner de «pago pendiente» en el panel del tenant. Visible para cualquier
 * usuario del tenant cuando la suscripción está impagada (`past_due`) o hay
 * add-ons suspendidos por impago. Enlaza a la pantalla de suscripción.
 */
export function PaymentAlertBanner() {
  const status = useBillingStatus();
  const data = status.data;
  if (!data?.hasIssue) return null;

  const parts: string[] = [];
  if (data.pastDue) parts.push('tu suscripción está pendiente de pago');
  if (data.suspendedAddons.length > 0) {
    const names = data.suspendedAddons.map((a) => a.name).join(', ');
    parts.push(`hay extras suspendidos por impago (${names})`);
  }
  const message = parts.join(' y ');

  return (
    <div className="border-b border-red-300 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
      <div className="container flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs font-medium">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        <span className="first-letter:uppercase">
          {message}. Regulariza el pago para reactivar la funcionalidad.
        </span>
        <Link
          href="/settings/saas-billing"
          className="underline underline-offset-2 hover:opacity-80"
        >
          Ver suscripción
        </Link>
      </div>
    </div>
  );
}
