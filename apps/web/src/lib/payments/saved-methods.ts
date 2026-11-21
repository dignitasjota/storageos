import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { SavedPaymentMethodsGroupDto, SavedPaymentMethodsSummaryDto } from '@storageos/shared';

export const savedMethodsKey = ['settings', 'payments', 'saved-methods'] as const;

/** Tarjetas y mandatos guardados de los inquilinos, por pasarela. */
export function useSavedMethodsSummary(enabled = true) {
  return useQuery({
    queryKey: savedMethodsKey,
    queryFn: () =>
      apiFetch<SavedPaymentMethodsSummaryDto>('/settings/payments/saved-methods-summary'),
    enabled,
    staleTime: 30_000,
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Texto del aviso antes de apagar una pasarela: cuántos inquilinos tienen algo
 * guardado con ella y cuántos cobros dejarían de hacerse solos. `null` si no
 * hay nada guardado (se apaga sin preguntar).
 */
export function savedMethodsWarning(
  group: SavedPaymentMethodsGroupDto | null | undefined,
  what: {
    saved: [string, string];
    charge: string;
    /** Lo guardado sigue sirviendo si se vuelve a activar. */
    reversible: boolean;
  },
  autoChargeOnIssue: boolean,
): string | null {
  if (!group || group.methods === 0) return null;
  const parts = [
    `${plural(group.customers, 'inquilino tiene', 'inquilinos tienen')} ${plural(
      group.methods,
      what.saved[0],
      what.saved[1],
    )} con esta forma de pago.`,
  ];
  if (group.autoChargedContracts > 0) {
    parts.push(
      autoChargeOnIssue
        ? `${plural(group.autoChargedContracts, 'cuota mensual deja', 'cuotas mensuales dejan')} de ${what.charge}: habrá que cobrarlas de otra forma.`
        : `${plural(group.autoChargedContracts, 'contrato la usa', 'contratos la usan')} para ${what.charge}.`,
    );
  }
  parts.push(
    what.reversible
      ? 'Si vuelves a activarla, lo guardado sigue sirviendo.'
      : 'Lo guardado se da de baja: tendrán que volver a darlo de alta.',
  );
  return parts.join(' ');
}
