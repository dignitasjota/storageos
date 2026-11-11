import { PrismaAdminService } from '../../src/modules/database/prisma-admin.service';

import type { INestApplication } from '@nestjs/common';

/**
 * Lleva la fecha de cobro de una remesa a ayer: el resultado del banco solo se
 * registra a partir del día del cargo.
 */
export async function reachCollectionDate(
  app: INestApplication,
  remittanceId: string,
): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await app.get(PrismaAdminService).sepaRemittance.update({
    where: { id: remittanceId },
    data: { collectionDate: new Date(`${yesterday}T00:00:00Z`) },
  });
}
