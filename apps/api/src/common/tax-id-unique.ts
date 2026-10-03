import { ConflictException } from '@nestjs/common';
import { normalizeTaxId } from '@storageos/shared';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * Un NIF solo puede pertenecer a una empresa de la plataforma. Veri*Factu
 * encadena los registros por emisor: dos tenants con el mismo NIF llevarían
 * dos cadenas distintas para el mismo obligado (y dos numeraciones), algo que
 * la AEAT no admite. 409 `tax_id_in_use` si otra empresa activa ya lo usa.
 */
export async function assertTaxIdFree(
  admin: PrismaAdminService,
  tenantId: string,
  taxId: string | null | undefined,
): Promise<void> {
  if (!taxId) return;
  const normalized = normalizeTaxId(taxId);
  if (!normalized) return;
  const other = await admin.tenant.findFirst({
    where: {
      id: { not: tenantId },
      deletedAt: null,
      taxId: { equals: normalized, mode: 'insensitive' },
    },
    select: { name: true },
  });
  if (other) {
    throw new ConflictException({
      code: 'tax_id_in_use',
      message: `El NIF ${normalized} ya lo usa otra empresa de la plataforma (${other.name}). Cada NIF solo puede tener una cuenta: si es la misma empresa, usa su cuenta y añade allí los locales.`,
    });
  }
}
