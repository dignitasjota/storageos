import type { Prisma } from '@storageos/database';

/**
 * Cambios de unos ajustes para el registro de actividad: los campos que
 * cambian con su valor anterior y el nuevo (los DTO de ajustes nunca llevan
 * secretos) y, aparte, qué secretos se han reescrito, sin su valor.
 */
export function settingsChanges(
  before: object | null,
  after: object,
  secretsSent: Record<string, unknown> = {},
): Prisma.InputJsonObject {
  const prev = (before ?? {}) as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    const a = prev[key];
    const b = next[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      changes[key] = { from: a ?? null, to: b ?? null };
    }
  }
  const secrets = Object.entries(secretsSent)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k]) => k);
  if (secrets.length > 0) changes.secretsChanged = secrets;
  return changes as Prisma.InputJsonObject;
}
