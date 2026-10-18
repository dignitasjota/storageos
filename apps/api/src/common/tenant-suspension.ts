/**
 * Tenant suspendido (impago de la suscripción o a mano): mientras dure, no se
 * cobra a sus inquilinos ni se les escribe (cobros y correos quedan en espera
 * y salen al reactivarse). El acceso físico no se toca.
 */

/** Pasado este tiempo en espera, un correo ya no se envía (se omite). */
export const HELD_COMMUNICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface TenantStatusReader {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { status: true };
    }): Promise<{ status: string } | null>;
  };
}

export async function isTenantSuspended(
  db: TenantStatusReader,
  tenantId: string,
): Promise<boolean> {
  const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  return row?.status === 'suspended';
}

/** Tenants que pueden volver a cobrar y escribir a sus inquilinos. */
export const RELEASABLE_TENANT = {
  deletedAt: null,
  status: { in: ['trial', 'active'] as ('trial' | 'active')[] },
};
