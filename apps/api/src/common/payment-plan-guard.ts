import type { Prisma } from '@storageos/database';

/**
 * ¿Está esta factura en un plan de pago activo? Mientras lo esté, el escalado
 * de impagos, los reintentos de cobro y la remesa SEPA no la reclaman entera:
 * se paga por cuotas.
 */
export async function invoiceInActivePlan(
  db: { paymentPlan: Prisma.TransactionClient['paymentPlan'] },
  invoiceId: string,
): Promise<boolean> {
  const found = await db.paymentPlan.findFirst({
    where: { status: 'active', invoiceIds: { has: invoiceId } },
    select: { id: true },
  });
  return !!found;
}
