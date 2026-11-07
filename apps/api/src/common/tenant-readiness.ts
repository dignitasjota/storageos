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

/**
 * Datos fiscales que le faltan al emisor para emitir una factura (RD 1619/2012,
 * art. 6: NIF, nombre o razón social y domicilio). Vacío = puede emitir.
 */
export function tenantFiscalDataMissing(t: {
  taxId: string | null;
  billingLegalName: string | null;
  billingAddress: string | null;
  billingPostalCode: string | null;
  billingCity: string | null;
}): string[] {
  if (skipped()) return [];
  const missing: string[] = [];
  if (!t.taxId?.trim()) missing.push('NIF');
  if (!t.billingLegalName?.trim()) missing.push('razón social');
  if (!t.billingAddress?.trim()) missing.push('domicilio fiscal');
  if (!t.billingPostalCode?.trim()) missing.push('código postal');
  if (!t.billingCity?.trim()) missing.push('municipio');
  return missing;
}
