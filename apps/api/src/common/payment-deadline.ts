import { PAYMENT_DEADLINE_MAX_DAYS } from '@storageos/shared';

const DAY_MS = 86_400_000;

/**
 * Último momento al que se puede llevar el plazo para firmar y pagar: 30 días
 * desde la reserva o desde la firma (lo más tarde de los dos).
 */
export function paymentDeadlineMax(contract: { createdAt: Date; signedAt: Date | null }): Date {
  const from = Math.max(contract.createdAt.getTime(), contract.signedAt?.getTime() ?? 0);
  return new Date(from + PAYMENT_DEADLINE_MAX_DAYS * DAY_MS);
}
