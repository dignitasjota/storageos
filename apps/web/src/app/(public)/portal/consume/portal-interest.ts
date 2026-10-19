import type { InterestKind } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

/**
 * Avisa al negocio de que el inquilino ha mirado una opción (seguro, otro
 * trastero, pase nocturno). Silencioso: si falla, no pasa nada.
 */
export function reportInterest(accessToken: string, kind: InterestKind, unitTypeId?: string): void {
  void apiFetch('/portal/me/interest', {
    method: 'POST',
    json: unitTypeId ? { kind, unitTypeId } : { kind },
    headers: { Authorization: `Bearer ${accessToken}` },
    requiresAuth: false,
  }).catch(() => undefined);
}
