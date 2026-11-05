import type { Prisma } from '@storageos/database';
import type { UnitHoldKind } from '@storageos/shared';

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
 * reserva online en plazo, una reserva anticipada firmada, un traslado
 * programado, el aviso de la lista de espera o el borrador de contrato que salió
 * de una reserva o de un aviso. Con `customerId` no cuenta lo que sea de ese
 * mismo inquilino; `reservationId` y `waitlistEntryId` descartan el propio
 * dueño, y `ignoreReservations` deja las reservas a la restricción de solape.
 */
export async function unitHeldByOther(
  tx: Prisma.TransactionClient,
  args: {
    unitId: string;
    contractId?: string;
    customerId?: string;
    reservationId?: string;
    waitlistEntryId?: string;
    ignoreReservations?: boolean;
  },
): Promise<boolean> {
  const now = new Date();
  const notSameCustomer = args.customerId ? { customerId: { not: args.customerId } } : {};
  // Una reserva sin inquilino también es de otro.
  const otherOrNobody = args.customerId
    ? { OR: [{ customerId: null }, { customerId: { not: args.customerId } }] }
    : {};
  const [reservations, contracts, moves, waitlist, drafts] = await Promise.all([
    args.ignoreReservations
      ? Promise.resolve(0)
      : tx.reservation.count({
          where: {
            unitId: args.unitId,
            status: { in: ['pending', 'confirmed'] },
            validUntil: { gt: now },
            ...(args.reservationId ? { id: { not: args.reservationId } } : {}),
            ...otherOrNobody,
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
    // Traslado programado hacia este trastero.
    tx.contract.count({
      where: {
        scheduledUnitId: args.unitId,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
        ...(args.contractId ? { id: { not: args.contractId } } : {}),
      },
    }),
    // Guardado para quien recibió el aviso de la lista de espera.
    tx.waitlistEntry.count({
      where: {
        heldUnitId: args.unitId,
        status: 'notified',
        ...(args.waitlistEntryId ? { id: { not: args.waitlistEntryId } } : {}),
        ...otherOrNobody,
      },
    }),
    tx.contract.findMany({
      where: {
        unitId: args.unitId,
        status: 'draft',
        deletedAt: null,
        ...(args.contractId ? { id: { not: args.contractId } } : {}),
        ...notSameCustomer,
      },
      select: { id: true },
    }),
  ]);
  if (reservations + contracts + moves + waitlist > 0) return true;
  if (drafts.length === 0) return false;
  // Borrador nacido de una reserva o de un aviso: el trastero sigue siendo suyo.
  const draftIds = drafts.map((d) => d.id);
  const [fromReservation, fromWaitlist] = await Promise.all([
    tx.reservation.count({
      where: { unitId: args.unitId, status: 'converted', convertedContractId: { in: draftIds } },
    }),
    tx.waitlistEntry.count({
      where: { heldUnitId: args.unitId, convertedContractId: { in: draftIds } },
    }),
  ]);
  return fromReservation + fromWaitlist > 0;
}

/**
 * Devuelve a la venta un trastero reservado, salvo que otro dueño lo siga
 * reteniendo. Todos los que sueltan un trastero pasan por aquí.
 */
export async function releaseReservedUnit(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    unitId: string;
    reason: string;
    userId?: string | null;
    contractId?: string;
    reservationId?: string;
    waitlistEntryId?: string;
  },
): Promise<boolean> {
  const held = await unitHeldByOther(tx, {
    unitId: args.unitId,
    ...(args.contractId ? { contractId: args.contractId } : {}),
    ...(args.reservationId ? { reservationId: args.reservationId } : {}),
    ...(args.waitlistEntryId ? { waitlistEntryId: args.waitlistEntryId } : {}),
  });
  if (held) return false;
  const { count } = await tx.unit.updateMany({
    where: { id: args.unitId, status: 'reserved' },
    data: { status: 'available' },
  });
  if (count === 0) return false;
  await tx.unitStatusHistory.create({
    data: {
      tenantId: args.tenantId,
      unitId: args.unitId,
      previousStatus: 'reserved',
      newStatus: 'available',
      changedByUserId: args.userId ?? null,
      reason: args.reason,
    },
  });
  return true;
}

export interface UnitHold {
  kind: UnitHoldKind;
  name: string | null;
  customerId: string | null;
  until: Date | null;
  link: string;
}

const HOLDER = {
  select: {
    id: true,
    customerType: true,
    firstName: true,
    lastName: true,
    companyName: true,
  },
} as const;

function holderName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

/** Quién retiene un trastero y hasta cuándo; null si nadie. */
export async function describeUnitHold(
  tx: Prisma.TransactionClient,
  unitId: string,
): Promise<UnitHold | null> {
  const now = new Date();
  const reservation = await tx.reservation.findFirst({
    where: { unitId, status: { in: ['pending', 'confirmed'] }, validUntil: { gt: now } },
    orderBy: { validUntil: 'asc' },
    include: { customer: HOLDER },
  });
  if (reservation) {
    return {
      kind: 'reservation',
      name: reservation.customer ? holderName(reservation.customer) : null,
      customerId: reservation.customerId,
      until: reservation.validUntil,
      link: '/reservations',
    };
  }
  const contract = await tx.contract.findFirst({
    where: {
      unitId,
      deletedAt: null,
      OR: [
        { status: 'draft', firstPaymentDeadline: { gt: now } },
        { status: 'active', preOpening: true, preOpeningStartedAt: null },
      ],
    },
    include: { customer: HOLDER },
  });
  if (contract) {
    return {
      kind: contract.status === 'draft' ? 'online_booking' : 'pre_opening',
      name: holderName(contract.customer),
      customerId: contract.customerId,
      until: contract.status === 'draft' ? contract.firstPaymentDeadline : null,
      link: `/contracts/${contract.id}`,
    };
  }
  const move = await tx.contract.findFirst({
    where: { scheduledUnitId: unitId, status: { in: ['active', 'ending'] }, deletedAt: null },
    include: { customer: HOLDER },
  });
  if (move) {
    return {
      kind: 'scheduled_move',
      name: holderName(move.customer),
      customerId: move.customerId,
      until: move.scheduledUnitDate,
      link: `/contracts/${move.id}`,
    };
  }
  const entry = await tx.waitlistEntry.findFirst({
    where: { heldUnitId: unitId, status: 'notified' },
  });
  if (entry) {
    return {
      kind: 'waitlist',
      name: entry.contactName,
      customerId: entry.customerId,
      until: entry.holdExpiresAt,
      link: '/waitlist',
    };
  }
  const draft = await tx.contract.findFirst({
    where: { unitId, status: 'draft', deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { customer: HOLDER },
  });
  if (draft) {
    return {
      kind: 'contract_draft',
      name: holderName(draft.customer),
      customerId: draft.customerId,
      until: null,
      link: `/contracts/${draft.id}`,
    };
  }
  return null;
}
