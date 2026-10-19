/**
 * Tenant suspendido por impago: escalado para que regularice. El acceso físico
 * de sus inquilinos nunca se corta.
 */

/** Días tras la suspensión en los que se avisa al propietario por correo. */
export const SUSPENSION_NOTICE_DAYS = [0, 7, 14] as const;

/** A partir de estos días suspendido, su web pública deja de verse. */
export const SUSPENSION_WEB_OFFLINE_DAYS = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días completos que lleva suspendido (desde `since`). */
export function suspensionDays(since: Date, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}
