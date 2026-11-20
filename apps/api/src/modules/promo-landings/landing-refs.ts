import type { Prisma } from '@storageos/database';

/**
 * Al borrar un local o un tamaño, las landings de promoción y las páginas de
 * zona dejan de apuntar a él (si no, ya no se podían guardar).
 *
 * En una landing, una lista vacía significa «todos»: si al quitarlo no queda
 * ninguno, la landing se apaga para que la promoción no se amplíe sola a todos
 * los locales o tamaños. Una página de zona sin locales sale en el panel como
 * «Sin locales».
 */
export async function forgetFacilityInWeb(
  tx: Prisma.TransactionClient,
  tenantId: string,
  facilityId: string,
): Promise<void> {
  const landings = await tx.promoLanding.findMany({
    where: { tenantId, facilityIds: { has: facilityId } },
    select: { id: true, facilityIds: true },
  });
  for (const l of landings) {
    const facilityIds = l.facilityIds.filter((x) => x !== facilityId);
    await tx.promoLanding.update({
      where: { id: l.id },
      data: { facilityIds, ...(facilityIds.length === 0 ? { isActive: false } : {}) },
    });
  }
  const pages = await tx.webAreaPage.findMany({
    where: { tenantId, facilityIds: { has: facilityId } },
    select: { id: true, facilityIds: true },
  });
  for (const p of pages) {
    await tx.webAreaPage.update({
      where: { id: p.id },
      data: { facilityIds: p.facilityIds.filter((x) => x !== facilityId) },
    });
  }
}

export async function forgetUnitTypeInWeb(
  tx: Prisma.TransactionClient,
  tenantId: string,
  unitTypeId: string,
): Promise<void> {
  const landings = await tx.promoLanding.findMany({
    where: { tenantId, unitTypeIds: { has: unitTypeId } },
    select: { id: true, unitTypeIds: true },
  });
  for (const l of landings) {
    const unitTypeIds = l.unitTypeIds.filter((x) => x !== unitTypeId);
    await tx.promoLanding.update({
      where: { id: l.id },
      data: { unitTypeIds, ...(unitTypeIds.length === 0 ? { isActive: false } : {}) },
    });
  }
}
