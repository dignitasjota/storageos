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

/**
 * De estas direcciones (en minúsculas), las que no pueden recibir ofertas: se
 * dieron de baja en alguna ficha del negocio, rebotan o marcaron spam.
 */
export async function blockedMarketingEmails(
  db: Db & {
    emailSuppression: {
      findMany: (args: {
        where: Prisma.EmailSuppressionWhereInput;
        select: { email: true };
      }) => Promise<Array<{ email: string }>>;
    };
  },
  tenantId: string,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const [customers, leads, suppressed] = await Promise.all([
    db.customer.findMany({
      where: {
        tenantId,
        deletedAt: null,
        marketingOptOutAt: { not: null },
        email: { in: emails, mode: 'insensitive' },
      },
      select: { email: true },
    }),
    db.lead.findMany({
      where: {
        tenantId,
        marketingOptOutAt: { not: null },
        email: { in: emails, mode: 'insensitive' },
      },
      select: { email: true },
    }),
    db.emailSuppression.findMany({
      where: { email: { in: emails }, OR: [{ tenantId }, { tenantId: null }] },
      select: { email: true },
    }),
  ]);
  return new Set(
    [...customers, ...leads, ...suppressed]
      .map((r) => r.email?.trim().toLowerCase())
      .filter((v): v is string => !!v),
  );
}
