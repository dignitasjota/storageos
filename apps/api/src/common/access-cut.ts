import type { Prisma } from '@storageos/database';

/**
 * Corte de acceso por impago que se aplicó de verdad. Que la acción `access_block`
 * esté ejecutada no basta: también queda así cuando no se cortó nada (política
 * «no cortar», decisión del equipo o las anteriores a que el corte funcionara).
 * Lo aplicado lleva `accessBlocked: true` en su resultado.
 */
export const ACCESS_CUT_APPLIED_WHERE = {
  actionType: 'access_block',
  status: 'executed',
  supersededAt: null,
  result: { path: ['accessBlocked'], equals: true },
} satisfies Prisma.DunningActionWhereInput;

type DunningResult = Prisma.JsonValue | null | undefined;

function resultObject(result: DunningResult): Record<string, unknown> | null {
  return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
}

/** Igual que `ACCESS_CUT_APPLIED_WHERE`, para acciones ya leídas. */
export function accessCutApplied(action: {
  actionType: string;
  status: string;
  result?: DunningResult;
}): boolean {
  return (
    action.actionType === 'access_block' &&
    action.status === 'executed' &&
    resultObject(action.result)?.accessBlocked === true
  );
}

/**
 * Acción ejecutada que no llegó a cortar nada y de la que nadie ha decidido: las
 * anteriores a que el corte funcionara. Sin `accessBlocked` en el resultado.
 */
export function accessCutUndecided(action: {
  actionType: string;
  status: string;
  result?: DunningResult;
}): boolean {
  return (
    action.actionType === 'access_block' &&
    action.status === 'executed' &&
    resultObject(action.result)?.accessBlocked === undefined
  );
}
