import type { PrismaAdminService } from '../database/prisma-admin.service';
import type { Prisma } from '@storageos/database';

/**
 * Trasteros que cuentan para el plan y para cobrar los de más: los de locales
 * que no están borrados (los mismos que cuenta el límite del plan).
 */
export const BILLABLE_UNITS_WHERE = (tenantId: string): Prisma.UnitWhereInput => ({
  tenantId,
  facility: { deletedAt: null },
});

export function billableUnits(admin: PrismaAdminService, tenantId: string): Promise<number> {
  return admin.unit.count({ where: BILLABLE_UNITS_WHERE(tenantId) });
}
