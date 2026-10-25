import { toCents } from '../../common/money';

import type { PrismaAdminService } from '../database/prisma-admin.service';

export interface ClaimedContractCredit {
  /** Céntimos descontados (0 si no había saldo). */
  cents: number;
  reason: string | null;
  /** Devuelve el saldo si la factura no llega a crearse. */
  restore: () => Promise<void>;
}

/**
 * Reserva el descuento pendiente de un contrato (p. ej. la señal de la reserva
 * ya cobrada) para restarlo del alquiler de la factura que se va a crear, hasta
 * `maxCents`. Atómico: dos procesos a la vez no descuentan el mismo saldo.
 */
export async function claimContractCredit(
  admin: PrismaAdminService,
  contractId: string,
  maxCents: number,
): Promise<ClaimedContractCredit> {
  const none: ClaimedContractCredit = { cents: 0, reason: null, restore: async () => undefined };
  if (maxCents <= 0) return none;
  const row = await admin.contract.findUnique({
    where: { id: contractId },
    select: { pendingCreditAmount: true, pendingCreditReason: true },
  });
  if (!row) return none;
  const available = toCents(Number(row.pendingCreditAmount));
  if (available <= 0) return none;
  const cents = Math.min(available, maxCents);
  const left = (available - cents) / 100;
  const claimed = await admin.contract.updateMany({
    where: { id: contractId, pendingCreditAmount: row.pendingCreditAmount },
    data: {
      pendingCreditAmount: left,
      ...(left === 0 ? { pendingCreditReason: null } : {}),
    },
  });
  if (claimed.count === 0) return none;
  return {
    cents,
    reason: row.pendingCreditReason,
    restore: async () => {
      await admin.contract.update({
        where: { id: contractId },
        data: {
          pendingCreditAmount: { increment: cents / 100 },
          pendingCreditReason: row.pendingCreditReason,
        },
      });
    },
  };
}

/** «25,00 €» sin depender de ICU. */
export function centsLabel(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
