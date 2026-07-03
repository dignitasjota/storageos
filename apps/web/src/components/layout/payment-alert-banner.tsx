'use client';

import { AlertTriangle, Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/auth/api';
import { useBillingStatus } from '@/lib/auth/hooks';
import { useCreateSupportTicket } from '@/lib/support/hooks';

/**
 * Banner de «pago pendiente» en el panel del tenant. Visible para cualquier
 * usuario del tenant cuando la suscripción está impagada (`past_due`) o hay
 * add-ons suspendidos por impago.
 *
 * - Plan (Stripe): se regulariza online → enlace a la suscripción (portal Stripe).
 * - Add-ons (pago manual/offline): no hay pago online → botón que abre un ticket
 *   de soporte al super admin para avisar del pago; él lo confirma y reactiva.
 */
export function PaymentAlertBanner() {
  const status = useBillingStatus();
  const createTicket = useCreateSupportTicket();
  const [notified, setNotified] = useState(false);

  const data = status.data;
  if (!data?.hasIssue) return null;

  const hasSuspendedAddons = data.suspendedAddons.length > 0;

  const parts: string[] = [];
  if (data.pastDue) parts.push('tu suscripción está pendiente de pago');
  if (hasSuspendedAddons) {
    const names = data.suspendedAddons.map((a) => a.name).join(', ');
    parts.push(`hay extras suspendidos por impago (${names})`);
  }
  const message = parts.join(' y ');

  async function notifyPayment() {
    const names = data!.suspendedAddons.map((a) => a.name).join(', ');
    try {
      await createTicket.mutateAsync({
        subject: 'Regularización de pago',
        body: `He realizado (o voy a realizar) el pago de los siguientes extras suspendidos: ${names}. Por favor, confirmad la recepción y reactivadlos.`,
        priority: 'high',
        category: 'billing',
      });
      setNotified(true);
      toast.success(
        'Aviso enviado. Lo revisaremos y reactivaremos los extras al confirmar el pago.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar el aviso.');
    }
  }

  return (
    <div className="border-b border-red-300 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
      <div className="container flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs font-medium">
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <span className="first-letter:uppercase">
            {message}.{' '}
            {data.pastDue && !hasSuspendedAddons
              ? 'Actualiza tu método de pago para regularizarla.'
              : 'Regulariza el pago para reactivar la funcionalidad.'}
          </span>
        </span>

        <span className="flex items-center gap-3">
          {/* Plan por Stripe: regularización online */}
          {data.pastDue && (
            <Link
              href="/settings/saas-billing"
              className="underline underline-offset-2 hover:opacity-80"
            >
              Actualizar método de pago
            </Link>
          )}
          {/* Add-ons manuales: avisar al proveedor vía ticket */}
          {hasSuspendedAddons &&
            (notified ? (
              <span className="flex items-center gap-1 text-red-700 dark:text-red-300">
                <Check className="size-3.5" /> Aviso enviado
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-red-300 bg-transparent px-2 text-xs text-red-800 hover:bg-red-100 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/40"
                onClick={notifyPayment}
                disabled={createTicket.isPending}
              >
                He realizado el pago
              </Button>
            ))}
        </span>
      </div>
    </div>
  );
}
