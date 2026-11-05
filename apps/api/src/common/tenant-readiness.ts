import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/** Lo que necesita un negocio para publicar su web y aceptar reservas online. */
export interface TenantReadiness {
  ownerVerified: boolean;
  hasFacility: boolean;
  hasCompany: boolean;
  hasPayment: boolean;
}

export async function tenantReadiness(
  admin: PrismaAdminService,
  tenantId: string,
): Promise<TenantReadiness> {
  const where = { tenantId };
  const [tenant, verified, facilities, redsys, gocardless, sepa, stripe] = await Promise.all([
    admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        taxId: true,
        billingLegalName: true,
        billingAddress: true,
        transferIban: true,
        offlineCashEnabled: true,
        offlineTransferEnabled: true,
        offlineSepaEnabled: true,
      },
    }),
    admin.user.count({ where: { ...where, emailVerifiedAt: { not: null } } }),
    admin.facility.count({ where: { ...where, deletedAt: null, isActive: true } }),
    admin.redsysSettings.count({ where: { ...where, enabled: true } }),
    admin.goCardlessSettings.count({ where: { ...where, enabled: true } }),
    admin.sepaSettings.count({ where: { ...where, enabled: true } }),
    admin.tenantStripeAccount.count({ where: { ...where, chargesEnabled: true } }),
  ]);
  return {
    ownerVerified: verified > 0,
    hasFacility: facilities > 0,
    hasCompany: !!(tenant?.taxId && tenant.billingLegalName && tenant.billingAddress),
    hasPayment:
      redsys + gocardless + sepa + stripe > 0 ||
      !!tenant?.transferIban ||
      !!tenant?.offlineCashEnabled ||
      !!tenant?.offlineTransferEnabled ||
      !!tenant?.offlineSepaEnabled,
  };
}

/**
 * Los e2e prueban la web y la reserva sin configurar todo esto: lo apagan con
 * `E2E_SKIP_READINESS`, salvo el que comprueba justo estas reglas.
 */
function skipped(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.E2E_SKIP_READINESS === 'true';
}

/** La web solo se publica con la cuenta activada y algún local. */
export function webPublished(r: TenantReadiness): boolean {
  return skipped() || (r.ownerVerified && r.hasFacility);
}

/**
 * Las reservas online exigen además datos fiscales (salen en el contrato que se
 * firma) y una forma de cobro.
 */
export function bookingReady(r: TenantReadiness): boolean {
  return skipped() || (webPublished(r) && r.hasCompany && r.hasPayment);
}
