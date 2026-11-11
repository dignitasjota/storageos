import { allocateInstallments } from '@storageos/shared';

import { toCents } from './money';

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

/** La cuota que toca pagar de un plan, en la factura por la que se paga. */
export interface PlanInstallmentDue {
  planId: string;
  /** La factura del plan que se paga ahora (la más antigua con algo pendiente). */
  invoiceId: string;
  /** Lo que queda de la cuota, sin pasar de lo pendiente de esa factura. */
  cents: number;
  dueDate: string;
  late: boolean;
}

/**
 * Cuota pendiente del plan activo de una factura: la primera que no está
 * pagada del todo (con lo cobrado de sus facturas desde que se creó el plan),
 * a pagar en la factura más antigua del plan que aún debe algo. Null si la
 * factura no está en un plan activo o ya no queda nada.
 */
export async function planInstallmentDue(
  db: Pick<Prisma.TransactionClient, 'paymentPlan' | 'invoice'>,
  invoiceId: string,
  today: string,
): Promise<PlanInstallmentDue | null> {
  const plan = await db.paymentPlan.findFirst({
    where: { status: 'active', invoiceIds: { has: invoiceId } },
    select: { id: true, invoiceIds: true, paidAtStart: true, installments: true, graceDays: true },
  });
  if (!plan) return null;
  const invoices = await db.invoice.findMany({
    where: { id: { in: plan.invoiceIds } },
    select: { id: true, status: true, total: true, amountPaid: true, issueDate: true },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
  });
  const paidCents =
    invoices.reduce((sum, i) => sum + toCents(i.amountPaid), 0) - toCents(plan.paidAtStart);
  const installments = allocateInstallments(
    plan.installments as { dueDate: string; amount: number }[],
    Math.max(0, paidCents) / 100,
    today,
    plan.graceDays,
  );
  const next = installments.find((i) => i.status !== 'paid');
  if (!next) return null;
  const payable = invoices.find(
    (i) =>
      (i.status === 'issued' || i.status === 'overdue') &&
      toCents(i.total) - toCents(i.amountPaid) > 0,
  );
  if (!payable) return null;
  const cents = Math.min(
    toCents(next.amount) - toCents(next.paid),
    toCents(payable.total) - toCents(payable.amountPaid),
  );
  if (cents <= 0) return null;
  return {
    planId: plan.id,
    invoiceId: payable.id,
    cents,
    dueDate: next.dueDate,
    late: next.status === 'late',
  };
}
