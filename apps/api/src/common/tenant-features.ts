import {
  effectiveFeaturesFromList,
  resolvePlanFeatures,
  type TenantFeature,
} from '@storageos/shared';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * ¿Tiene el tenant esta funcionalidad ahora mismo? Plan (jsonb del plan o
 * mapa en código) + overrides del super admin, igual que el `FeatureGuard`.
 * Para flujos sin request (listeners, crons, envíos) donde no hay guard.
 */
export async function tenantHasFeature(
  admin: PrismaAdminService,
  tenantId: string,
  feature: TenantFeature,
): Promise<boolean> {
  const [subscription, overrides] = await Promise.all([
    admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true, tenantFeatures: true } } },
    }),
    admin.tenantFeatureOverride.findMany({
      where: { tenantId },
      select: { feature: true, enabled: true },
    }),
  ]);
  const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
  return effectiveFeaturesFromList(
    base,
    overrides as { feature: TenantFeature; enabled: boolean }[],
  ).includes(feature);
}
