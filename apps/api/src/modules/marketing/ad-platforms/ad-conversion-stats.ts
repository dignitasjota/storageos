import type { Prisma } from '@storageos/database';
import type { AdConversionStatsDto } from '@storageos/shared';

export type AdConversionPlatform = 'google_ads' | 'meta';

/** Envíos de los últimos 30 días a una plataforma (para la tarjeta de ajustes). */
export async function adConversionStats(
  tx: Prisma.TransactionClient,
  platform: AdConversionPlatform,
): Promise<AdConversionStatsDto> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [sent, failed, lastFailed, lastSent] = await Promise.all([
    tx.adConversionUpload.count({ where: { platform, status: 'sent', createdAt: { gte: since } } }),
    tx.adConversionUpload.count({
      where: { platform, status: 'failed', createdAt: { gte: since } },
    }),
    tx.adConversionUpload.findFirst({
      where: { platform, status: 'failed', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { error: true },
    }),
    tx.adConversionUpload.findFirst({
      where: { platform, status: 'sent' },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
  ]);
  return {
    sent,
    failed,
    lastError: lastFailed?.error ?? null,
    lastSentAt: lastSent?.sentAt?.toISOString() ?? null,
  };
}

/** Al cambiar la configuración se vuelven a intentar los envíos que fallaron. */
export async function retryFailedConversions(
  tx: Prisma.TransactionClient,
  platform: AdConversionPlatform,
): Promise<void> {
  await tx.adConversionUpload.deleteMany({ where: { platform, status: 'failed' } });
}
