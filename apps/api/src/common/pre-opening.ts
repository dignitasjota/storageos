import type { ContractPreOpeningDto } from '@storageos/shared';

/**
 * Contratos que ya han empezado: excluye las reservas anticipadas cuyo local
 * aún no ha abierto (sin acceso, sin facturación recurrente, fuera del MRR).
 * Se combina con `status: { in: ['active', 'ending'] }`.
 */
export const STARTED_CONTRACT_WHERE = {
  NOT: { preOpening: true, preOpeningStartedAt: null },
} as const;

/** ¿Es una reserva anticipada que aún no ha empezado? */
export function isPendingPreOpening(c: {
  preOpening: boolean;
  preOpeningStartedAt: Date | null;
}): boolean {
  return c.preOpening && !c.preOpeningStartedAt;
}

/** Datos de la reserva anticipada para los DTO (null si el contrato no lo es). */
export function preOpeningDto(c: {
  preOpening: boolean;
  preOpeningDateConfirmed: boolean;
  preOpeningDeadline: Date | null;
  preOpeningStartedAt: Date | null;
  startDate: Date;
}): ContractPreOpeningDto | null {
  if (!c.preOpening) return null;
  return {
    dateConfirmed: c.preOpeningDateConfirmed,
    openingDate: c.preOpeningDateConfirmed ? c.startDate.toISOString().slice(0, 10) : null,
    deadline: c.preOpeningDeadline ? c.preOpeningDeadline.toISOString().slice(0, 10) : null,
    startedAt: c.preOpeningStartedAt ? c.preOpeningStartedAt.toISOString() : null,
  };
}
