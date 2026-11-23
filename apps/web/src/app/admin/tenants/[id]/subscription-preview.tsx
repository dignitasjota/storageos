'use client';

import { Loader2 } from 'lucide-react';

import type { AdminSubscriptionStateDto, SubscriptionPreviewQuery } from '@storageos/shared';

import { subscriptionStatusLabel, tenantStatusLabel } from '@/lib/admin/labels';
import { useSubscriptionPreview } from '@/lib/admin/tenant-lifecycle-hooks';
import { ApiError } from '@/lib/auth/api';

const MODE: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'SEPA',
  redsys: 'Tarjeta (Redsys)',
  manual: 'Manual',
};
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');

function rows(s: AdminSubscriptionStateDto): [string, string][] {
  return [
    ['Estado', tenantStatusLabel(s.tenantStatus)],
    ['Suscripción', s.subscriptionStatus ? subscriptionStatusLabel(s.subscriptionStatus) : '—'],
    ['Plan', s.planName ?? '—'],
    [
      'Cobro',
      s.billingExempt ? 'Exenta' : s.billingMode ? (MODE[s.billingMode] ?? s.billingMode) : '—',
    ],
    ['Fin de la prueba', day(s.trialEndsAt)],
    ['Fin del periodo', day(s.periodEnd)],
    [
      'Próximo cargo',
      s.nextCharge ? `${eur(s.nextCharge.amount)} el ${day(s.nextCharge.date)}` : 'Ninguno',
    ],
    ['Deuda', s.debt ? `${eur(s.debt.amount)} desde el ${day(s.debt.since)}` : 'No debe'],
  ];
}

/**
 * Cómo está la suscripción y cómo quedará con la acción, y lo que pasará
 * (correos, Stripe, remesa). Se enseña en cada diálogo antes de confirmar.
 */
export function SubscriptionPreviewBox({
  tenantId,
  query,
}: {
  tenantId: string;
  query: SubscriptionPreviewQuery | null;
}) {
  const preview = useSubscriptionPreview(tenantId, query);
  if (!query) return null;
  if (preview.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Calculando cómo queda…
      </p>
    );
  }
  if (preview.isError) {
    return (
      <p className="text-xs text-destructive">
        {preview.error instanceof ApiError
          ? preview.error.body.message
          : 'No se pudo calcular la vista previa.'}
      </p>
    );
  }
  const p = preview.data;
  if (!p) return null;
  const before = rows(p.before);
  const after = rows(p.after);
  return (
    <div className="space-y-2 rounded-md border p-2 text-xs">
      <table className="w-full">
        <thead className="text-muted-foreground">
          <tr>
            <th className="text-left font-normal" />
            <th className="text-left font-normal">Ahora</th>
            <th className="text-left font-normal">Después</th>
          </tr>
        </thead>
        <tbody>
          {before.map(([label, value], i) => {
            const next = after[i]?.[1] ?? '—';
            return (
              <tr key={label}>
                <td className="pr-2 text-muted-foreground">{label}</td>
                <td className="pr-2">{value}</td>
                <td className={next !== value ? 'font-medium' : ''}>{next}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-muted-foreground">
        Importes {p.pricesIncludeVat ? 'con el IVA incluido' : 'con el IVA'}.
      </p>
      {p.effects.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {p.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {p.warnings.map((w) => (
        <p
          key={w}
          className="rounded-md border border-amber-300 bg-amber-50 p-1.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {w}
        </p>
      ))}
    </div>
  );
}
