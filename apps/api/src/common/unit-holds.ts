import type { Prisma } from '@storageos/database';

/**
 * Filtro de trasteros libres de verdad: sin una reserva viva. Una reserva
 * pendiente no pone el trastero en «reservado», pero tampoco se le puede vender
 * a otro (la firma daría `unit_reserved_for_other`).
 */
export function noLiveReservationWhere(now = new Date()): Prisma.UnitWhereInput {
  return {
    reservations: { none: { status: { in: ['pending', 'confirmed'] }, validUntil: { gt: now } } },
  };
}

/**
 * ¿Retiene alguien más este trastero? Una reserva viva o el borrador de una
 * reserva online en plazo, o una reserva anticipada firmada. Con `customerId`
 * no cuenta lo que sea de ese mismo inquilino.
 */
export async function unitHeldByOther(
  tx: Prisma.TransactionClient,
  args: { unitId: string; contractId?: string; customerId?: string },
): Promise<boolean> {
  const now = new Date();
  const notSameCustomer = args.customerId ? { customerId: { not: args.customerId } } : {};
  const [reservations, contracts] = await Promise.all([
    tx.reservation.count({
      where: {
        unitId: args.unitId,
        status: { in: ['pending', 'confirmed'] },
        validUntil: { gt: now },
        ...notSameCustomer,
      },
    }),
    tx.contract.count({
      where: {
        unitId: args.unitId,
        deletedAt: null,
        ...(args.contractId ? { id: { not: args.contractId } } : {}),
        ...notSameCustomer,
        OR: [
          { status: 'draft', firstPaymentDeadline: { gt: now } },
          { status: 'active', preOpening: true, preOpeningStartedAt: null },
        ],
      },
    }),
  ]);
  return reservations + contracts > 0;
}
