'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

import { useHasPermission } from '@/lib/auth/hooks';
import { useVerifactuAlertQuery } from '@/lib/billing/verifactu-hooks';
import { formatDateTime } from '@/lib/format';

/** Termina la frase con punto si no lo lleva. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/**
 * Aviso de que hay facturas que no han podido llegar a la AEAT (art. 16.4 de
 * la Orden HAC/1177/2024: el sistema avisa de la incidencia y de cuántos
 * registros quedan por enviar). Se reintenta solo; el aviso desaparece en
 * cuanto salen.
 */
export function VerifactuAlertBanner() {
  const canRead = useHasPermission('invoices:read');
  const alert = useVerifactuAlertQuery(canRead);
  const data = alert.data;
  if (!data || data.unsentCount === 0) return null;

  const count =
    data.unsentCount === 1
      ? '1 factura no ha podido llegar a la AEAT'
      : `${data.unsentCount} facturas no han podido llegar a la AEAT`;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-500/40 bg-red-50 px-4 py-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{count}</span>
        {data.since && ` desde el ${formatDateTime(data.since)}`}.{' '}
        {data.lastError && `${sentence(data.lastError)} `}
        {data.unsentCount === 1
          ? 'Saldrá marcada como enviada tarde por una incidencia.'
          : 'Saldrán marcadas como enviadas tarde por una incidencia.'}
      </p>
      <Link href="/settings/billing/verifactu" className="shrink-0 font-medium underline">
        Ver Veri*Factu
      </Link>
    </div>
  );
}
