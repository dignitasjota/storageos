import { BILLING_PROBLEM_LABELS, type BillingInvoiceProblem } from '@storageos/shared';

import { ApiError } from '@/lib/auth/api';

/** Mensaje legible de un error de la API (o el de reserva si no lo hay). */
export function apiMessage(err: unknown, fallback = 'No se pudo completar.'): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

export const PROBLEM_TONE: Record<BillingInvoiceProblem, string> = {
  rejected: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  warnings: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  stale: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  unsent: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
};

export function ProblemChip({ problem }: { problem: BillingInvoiceProblem }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${PROBLEM_TONE[problem]}`}>
      {BILLING_PROBLEM_LABELS[problem]}
    </span>
  );
}
