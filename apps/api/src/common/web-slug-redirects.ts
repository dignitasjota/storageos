import type { Prisma } from '@storageos/database';

/**
 * Direcciones antiguas de las entradas del blog (`blog`) y de las landings de
 * promoción (`promo`): al cambiar la dirección, la vieja sigue llevando a la
 * página (la web responde 308 a la nueva). Apuntan a la página por su id, así
 * que varios cambios seguidos llevan siempre a la dirección actual.
 */
export type WebSlugRedirectKind = 'blog' | 'promo';

/**
 * Tras cambiar la dirección: la antigua redirige a la página y, si la nueva era
 * la antigua de otra página, deja de redirigir (ahora es de esta).
 */
export async function rememberOldSlug(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    kind: WebSlugRedirectKind;
    oldSlug: string;
    newSlug: string;
    targetId: string;
  },
): Promise<void> {
  const { tenantId, kind, oldSlug, newSlug, targetId } = args;
  if (oldSlug === newSlug) return;
  await forgetOldSlug(tx, { tenantId, kind, slug: newSlug });
  await tx.webSlugRedirect.upsert({
    where: { tenantId_kind_oldSlug: { tenantId, kind, oldSlug } },
    create: { tenantId, kind, oldSlug, targetId },
    update: { targetId },
  });
}

/** Una página nueva (o renombrada) toma esa dirección: deja de redirigir a otra. */
export async function forgetOldSlug(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; kind: WebSlugRedirectKind; slug: string },
): Promise<void> {
  await tx.webSlugRedirect.deleteMany({
    where: { tenantId: args.tenantId, kind: args.kind, oldSlug: args.slug },
  });
}

/** Al borrar la página, sus direcciones antiguas dejan de existir. */
export async function forgetRedirectsTo(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; kind: WebSlugRedirectKind; targetId: string },
): Promise<void> {
  await tx.webSlugRedirect.deleteMany({
    where: { tenantId: args.tenantId, kind: args.kind, targetId: args.targetId },
  });
}
