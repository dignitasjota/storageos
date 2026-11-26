import { PrismaAdminService } from '../database/prisma-admin.service';

/**
 * Hasta qué día se ha descargado con éxito Search Console en esos dominios (el
 * más antiguo de ellos). null si alguno aún no se ha descargado: entonces la
 * cobertura de un periodo se mide por los días con filas.
 */
export async function syncedUntilOf(
  admin: PrismaAdminService,
  domainIds: readonly string[],
): Promise<string | null> {
  if (domainIds.length === 0) return null;
  const rows = await admin.seoProjectDomain.findMany({
    where: { id: { in: [...domainIds] } },
    select: { syncedUntil: true },
  });
  if (rows.length === 0 || rows.some((r) => !r.syncedUntil)) return null;
  return rows
    .map((r) => r.syncedUntil!.toISOString().slice(0, 10))
    .reduce((a, b) => (a < b ? a : b));
}
