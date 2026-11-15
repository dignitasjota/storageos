import type { Prisma } from '@storageos/database';

/**
 * Contrato que hace de alguien un ex-cliente: firmado y terminado. Una reserva
 * online que caducó sin pagar (cancelada con el plazo aún puesto) no cuenta:
 * nunca llegó a ser cliente.
 */
export const FORMER_CONTRACT_WHERE: Prisma.ContractWhereInput = {
  deletedAt: null,
  signedAt: { not: null },
  OR: [{ status: 'ended' }, { status: 'cancelled', firstPaymentDeadline: null }],
};

/** Expedientes de impago que impiden escribirle una oferta comercial. */
const DEBT_CASE_STATUSES = [
  'open',
  'overlocked',
  'final_notice',
  'resolution_pending',
  'contract_resolved',
  'goods_moved',
  'disposal',
  'closed_disposed',
] as const;

/** Sin facturas vencidas ni expedientes de impago (abiertos o cerrados sin cobrar). */
export function noDebtWhere(now = new Date()): Prisma.CustomerWhereInput {
  return {
    invoices: {
      none: {
        deletedAt: null,
        kind: 'invoice',
        OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: now } }],
      },
    },
    delinquencyCases: { none: { status: { in: [...DEBT_CASE_STATUSES] } } },
  };
}

/**
 * Ex-cliente al que se le puede ofrecer volver: tuvo un contrato terminado
 * (en ese local, si se indica), no tiene ninguno vivo y no se fue debiendo.
 */
export function formerCustomerWhere(
  inFacility: Prisma.ContractWhereInput = {},
): Prisma.CustomerWhereInput {
  return {
    AND: [
      { contracts: { some: { ...FORMER_CONTRACT_WHERE, ...inFacility } } },
      { contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } } },
      noDebtWhere(),
    ],
  };
}
