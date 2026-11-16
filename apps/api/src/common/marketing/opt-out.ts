import type { Prisma } from '@storageos/database';

type Db = {
  customer: Prisma.TransactionClient['customer'];
  lead: Prisma.TransactionClient['lead'];
};

/**
 * La baja de las comunicaciones comerciales va por dirección de email: se
 * aplica a todas las fichas del negocio con ese email (dos inquilinos, un
 * contacto y su inquilino…). Antes, darse de baja desde una dejaba a la otra
 * recibiendo campañas. `optedOutAt: null` = vuelve a recibirlas.
 */
export async function applyMarketingOptOutByEmail(
  db: Db,
  tenantId: string,
  email: string | null | undefined,
  optedOutAt: Date | null,
): Promise<void> {
  const address = email?.trim();
  if (!address) return;
  const same = { tenantId, email: { equals: address, mode: 'insensitive' as const } };
  if (optedOutAt) {
    await db.customer.updateMany({
      where: { ...same, marketingOptOutAt: null },
      data: { marketingOptOutAt: optedOutAt },
    });
    await db.lead.updateMany({
      where: { ...same, marketingOptOutAt: null },
      data: { marketingOptOutAt: optedOutAt },
    });
    return;
  }
  await db.customer.updateMany({
    where: { ...same, marketingOptOutAt: { not: null } },
    data: { marketingOptOutAt: null },
  });
  await db.lead.updateMany({
    where: { ...same, marketingOptOutAt: { not: null } },
    data: { marketingOptOutAt: null },
  });
}
