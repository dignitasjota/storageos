import { tenantHasFeature } from './tenant-features';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

export type CustomDomainPauseChange = 'paused' | 'resumed' | null;

/**
 * Sincroniza el dominio propio de un negocio con su plan.
 *
 * `custom_domain_verified_at` es lo que miran todos los sitios que construyen
 * enlaces (firma, portal, reserva, correos, avisos, web, CORS…). Si el plan ya
 * no incluye la función, ese campo se deja en null (los enlaces vuelven solos
 * a la dirección de la plataforma) y la fecha de activación se guarda en
 * `custom_domain_paused_verified_at`. Si la función vuelve, se restaura.
 *
 * Es idempotente y barato: se llama tras cualquier cambio de plan, de
 * funciones o de extras, y la tarea `custom-domains.plan-sync` repasa todos
 * los negocios por si algún camino (Stripe, caducidad de una cortesía…) no lo
 * hizo.
 */
export async function reconcileCustomDomainPause(
  admin: PrismaAdminService,
  tenantId: string,
): Promise<CustomDomainPauseChange> {
  const t = await admin.tenant.findUnique({
    where: { id: tenantId },
    select: {
      customDomain: true,
      customDomainVerifiedAt: true,
      customDomainPausedVerifiedAt: true,
    },
  });
  if (!t?.customDomain) return null;
  if (!t.customDomainVerifiedAt && !t.customDomainPausedVerifiedAt) return null;
  const included = await tenantHasFeature(admin, tenantId, 'custom_domain');
  if (!included && t.customDomainVerifiedAt) {
    // Reserva atómica: solo una réplica pausa.
    const claimed = await admin.tenant.updateMany({
      where: { id: tenantId, customDomainVerifiedAt: { not: null } },
      data: {
        customDomainPausedVerifiedAt: t.customDomainVerifiedAt,
        customDomainVerifiedAt: null,
      },
    });
    return claimed.count > 0 ? 'paused' : null;
  }
  if (included && !t.customDomainVerifiedAt && t.customDomainPausedVerifiedAt) {
    const claimed = await admin.tenant.updateMany({
      where: {
        id: tenantId,
        customDomainVerifiedAt: null,
        customDomainPausedVerifiedAt: { not: null },
      },
      data: {
        customDomainVerifiedAt: t.customDomainPausedVerifiedAt,
        customDomainPausedVerifiedAt: null,
      },
    });
    return claimed.count > 0 ? 'resumed' : null;
  }
  return null;
}

/** Repasa todos los negocios con dominio propio activo o en pausa. */
export async function reconcileAllCustomDomainPauses(
  admin: PrismaAdminService,
): Promise<{ paused: string[]; resumed: string[] }> {
  const rows = await admin.tenant.findMany({
    where: {
      customDomain: { not: null },
      deletedAt: null,
      OR: [
        { customDomainVerifiedAt: { not: null } },
        { customDomainPausedVerifiedAt: { not: null } },
      ],
    },
    select: { id: true },
  });
  const out = { paused: [] as string[], resumed: [] as string[] };
  for (const r of rows) {
    const change = await reconcileCustomDomainPause(admin, r.id);
    if (change === 'paused') out.paused.push(r.id);
    if (change === 'resumed') out.resumed.push(r.id);
  }
  return out;
}
