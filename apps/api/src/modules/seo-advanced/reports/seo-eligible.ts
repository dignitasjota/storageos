import { tenantHasFeature } from '../../../common/tenant-features';

import type { PrismaAdminService } from '../../database/prisma-admin.service';

/**
 * Un proyecto trabaja solo (conversiones, alertas e informes) si es de la
 * plataforma o su tenant sigue activo (o en prueba) y tiene SEO Avanzado.
 */
export async function seoProjectEligible(
  admin: PrismaAdminService,
  tenantId: string | null,
): Promise<boolean> {
  if (!tenantId) return true;
  const tenant = await admin.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, deletedAt: true },
  });
  if (!tenant || tenant.deletedAt || !['active', 'trial'].includes(tenant.status)) return false;
  return tenantHasFeature(admin, tenantId, 'seo_advanced');
}
