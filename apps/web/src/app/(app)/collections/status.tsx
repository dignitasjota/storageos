import type { DelinquencyCaseStatus } from '@storageos/shared';

export const CASE_STATUS_LABELS: Record<DelinquencyCaseStatus, string> = {
  open: 'Abierto',
  overlocked: 'Con candado',
  final_notice: 'Requerimiento enviado',
  resolution_pending: 'Plazo vencido',
  disposal: 'En disposición',
  closed_paid: 'Cerrado · pagado',
  closed_disposed: 'Cerrado · dispuesto',
  closed_cancelled: 'Cerrado · cancelado',
};

export const CASE_STATUS_CLASSES: Record<DelinquencyCaseStatus, string> = {
  open: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  overlocked: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  final_notice: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  resolution_pending: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  disposal: 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300',
  closed_paid: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  closed_disposed: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  closed_cancelled: 'bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400',
};

export const CASE_EVENT_LABELS: Record<string, string> = {
  opened: 'Expediente abierto',
  overlock_placed: 'Candado colocado',
  overlock_removed: 'Candado retirado',
  notice_sent: 'Requerimiento enviado',
  deadline_expired: 'Plazo vencido',
  payment_received: 'Pago recibido',
  inventory_done: 'Inventario / inicio de disposición',
  disposal_done: 'Disposición completada',
  settlement_done: 'Liquidación',
  closed: 'Expediente cerrado',
  note: 'Nota',
};

export const eur = (cents: number): string =>
  (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
