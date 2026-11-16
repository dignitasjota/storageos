import type { PrismaAdminService } from '../../modules/database/prisma-admin.service';

/**
 * ¿El negocio devuelve los contratos firmados a Google Ads o a Meta? Entonces
 * su web pide permiso (aviso de cookies) para guardar el clic en el anuncio.
 */
export async function adConversionsEnabled(
  admin: PrismaAdminService,
  tenantId: string,
): Promise<boolean> {
  const [google, meta] = await Promise.all([
    admin.googleAdsSettings.count({
      where: { tenantId, enabled: true, conversionActionId: { not: null } },
    }),
    admin.metaAdsSettings.count({ where: { tenantId, enabled: true, pixelId: { not: null } } }),
  ]);
  return google + meta > 0;
}
